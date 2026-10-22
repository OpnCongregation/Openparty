package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Witness keeps its own full copy of the log, verifies every new head is a
// consistent extension of the last one it saw, and only then cosigns.
type Witness struct {
	priv   ed25519.PrivateKey
	logURL string
	logKey ed25519.PublicKey

	mu     sync.Mutex
	copy   *Log
	root   string
	alarm  string
	client *http.Client
}

func NewWitness(priv ed25519.PrivateKey, logURL, logKeyHex string) *Witness {
	k, _ := hex.DecodeString(logKeyHex)
	cp, _ := OpenLog("", priv)
	return &Witness{priv: priv, logURL: strings.TrimRight(logURL, "/"), logKey: k, copy: cp,
		root: hex.EncodeToString(emptyRoot()), client: &http.Client{Timeout: 5 * time.Second}}
}

func (w *Witness) pub() ed25519.PublicKey { return w.priv.Public().(ed25519.PublicKey) }

func (w *Witness) getJSON(path string, v any) error {
	resp, err := w.client.Get(w.logURL + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: status %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func (w *Witness) Run(every time.Duration) {
	for range time.Tick(every) {
		if err := w.sync(); err != nil {
			w.mu.Lock()
			if strings.HasPrefix(err.Error(), "TAMPER") {
				w.alarm = err.Error()
			}
			w.mu.Unlock()
		}
	}
}

func (w *Witness) sync() error {
	var hr struct {
		Head SignedHead `json:"head"`
	}
	if err := w.getJSON("/head", &hr); err != nil {
		return err
	}
	h := hr.Head
	sig, _ := hex.DecodeString(h.Signature)
	if len(w.logKey) != ed25519.PublicKeySize || !ed25519.Verify(w.logKey, headMessage(h.Size, h.Root), sig) {
		return fmt.Errorf("TAMPER: head signature invalid")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	old := w.copy.Size()
	if h.Size < old {
		return fmt.Errorf("TAMPER: log shrank from %d to %d", old, h.Size)
	}
	if h.Size == old {
		if h.Root != w.root {
			return fmt.Errorf("TAMPER: same size %d, different root", old)
		}
		return nil
	}
	if old > 0 {
		var cp struct {
			OldRoot string   `json:"oldRoot"`
			NewRoot string   `json:"newRoot"`
			Proof   []string `json:"proof"`
		}
		if err := w.getJSON(fmt.Sprintf("/proof/consistency?old=%d&new=%d", old, h.Size), &cp); err != nil {
			return err
		}
		proof := make([][]byte, len(cp.Proof))
		for i, p := range cp.Proof {
			proof[i], _ = hex.DecodeString(p)
		}
		or, _ := hex.DecodeString(w.root)
		nr, _ := hex.DecodeString(h.Root)
		if err := verifyConsistency(old, h.Size, or, nr, proof); err != nil {
			return fmt.Errorf("TAMPER: history rewritten: %v", err)
		}
	}
	// The log serves entries in pages; keep asking until we hold everything up to the head we verified.
	for w.copy.Size() < h.Size {
		var er struct {
			Entries []string `json:"entries"`
		}
		if err := w.getJSON(fmt.Sprintf("/entries?from=%d&to=%d", w.copy.Size(), h.Size), &er); err != nil {
			return err
		}
		if len(er.Entries) == 0 {
			return fmt.Errorf("log returned no entries at %d although its head says %d", w.copy.Size(), h.Size)
		}
		for _, e := range er.Entries {
			b, err := base64.StdEncoding.DecodeString(e)
			if err != nil {
				return err
			}
			w.copy.AppendAlways(b)
		}
	}
	got, _ := w.copy.RootAt(w.copy.Size())
	if hex.EncodeToString(got) != h.Root {
		return fmt.Errorf("TAMPER: entries do not hash to head root %s", h.Root)
	}
	w.root = h.Root
	return nil
}

func (w *Witness) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /cosign", func(rw http.ResponseWriter, r *http.Request) {
		w.mu.Lock()
		defer w.mu.Unlock()
		if w.alarm != "" {
			writeJSON(rw, 409, map[string]string{"error": w.alarm})
			return
		}
		size, root := w.copy.Size(), w.root
		if r.URL.Query().Get("root") != root || r.URL.Query().Get("size") != fmt.Sprint(size) {
			writeJSON(rw, 404, map[string]string{"error": "not yet verified"})
			return
		}
		sig := ed25519.Sign(w.priv, headMessage(size, root))
		writeJSON(rw, 200, Cosignature{Witness: hex.EncodeToString(w.pub()), Signature: hex.EncodeToString(sig)})
	})
	mux.HandleFunc("GET /status", func(rw http.ResponseWriter, r *http.Request) {
		w.mu.Lock()
		defer w.mu.Unlock()
		writeJSON(rw, 200, map[string]any{"size": w.copy.Size(), "root": w.root, "alarm": w.alarm, "key": hex.EncodeToString(w.pub())})
	})
	mux.HandleFunc("GET /healthz", func(rw http.ResponseWriter, r *http.Request) {
		writeJSON(rw, 200, map[string]string{"status": "ok"})
	})
	return mux
}
