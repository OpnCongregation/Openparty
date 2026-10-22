package main

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	log        *Log
	token      string
	witnessURL []string
	anchorPath string
	calendars  []string     // OpenTimestamps calendar servers; empty means simulated anchoring
	client     *http.Client // nil uses a default with a timeout (tests inject their own)
	limiter    *ipLimiter   // per-address request limit for the public endpoints; nil = unlimited (tests)

	semOnce  sync.Once
	proofSem chan struct{} // bounds concurrent proof computations

	headMu    sync.Mutex
	headCache struct {
		at   time.Time
		size int
		root string
		cos  []Cosignature
	}
}

// withProofSlot runs fn if a proof slot is free, otherwise answers 503. Proofs cost O(log size) hashes over data that
// must be re-read from memory each time, so they are bounded instead of allowed to pile up.
func (s *Server) withProofSlot(w http.ResponseWriter, fn func()) {
	s.semOnce.Do(func() { s.proofSem = make(chan struct{}, maxConcurrentProof) })
	select {
	case s.proofSem <- struct{}{}:
		defer func() { <-s.proofSem }()
		fn()
	default:
		w.Header().Set("Retry-After", "1")
		writeJSON(w, 503, map[string]string{"error": "busy"})
	}
}

// cosigsFor returns witness cosignatures for the head, reusing a result under a second old so that many readers
// polling /head do not each trigger a round of outbound requests to every witness.
func (s *Server) cosigsFor(h SignedHead) []Cosignature {
	s.headMu.Lock()
	defer s.headMu.Unlock()
	c := &s.headCache
	if c.size == h.Size && c.root == h.Root && time.Since(c.at) < time.Second {
		return c.cos
	}
	c.cos = s.collectCosigs(h)
	c.at, c.size, c.root = time.Now(), h.Size, h.Root
	return c.cos
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func hexList(p [][]byte) []string {
	out := make([]string, len(p))
	for i, b := range p {
		out[i] = hex.EncodeToString(b)
	}
	return out
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /append", func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if s.token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		// A record over the cap is refused, never silently cut short: a truncated record would be logged as if complete.
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAppendBytes))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeJSON(w, 413, map[string]string{"error": "record too large"})
				return
			}
			writeJSON(w, 400, map[string]string{"error": "unreadable body"})
			return
		}
		if len(body) == 0 {
			writeJSON(w, 400, map[string]string{"error": "empty body"})
			return
		}
		idx, dup, err := s.log.AppendOnce(body)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		code := 201
		if dup {
			code = 200 // same idempotency key as an earlier entry: nothing was written
		}
		writeJSON(w, code, map[string]any{"index": idx, "duplicate": dup, "leafHash": hex.EncodeToString(hashLeaf(body))})
	})

	mux.HandleFunc("GET /head", func(w http.ResponseWriter, r *http.Request) {
		h := s.log.Head()
		writeJSON(w, 200, map[string]any{"head": h, "cosignatures": s.cosigsFor(h)})
	})

	// Entries are returned in pages: at most maxEntriesPerPage entries and about maxEntriesBytes of data per call. The
	// reply says where the next page starts ("next"); a caller that wants a range keeps asking until next reaches `to`.
	mux.HandleFunc("GET /entries", func(w http.ResponseWriter, r *http.Request) {
		size := s.log.Size()
		from, to := 0, size
		var err error
		if v := r.URL.Query().Get("from"); v != "" {
			if from, err = strconv.Atoi(v); err != nil {
				writeJSON(w, 400, map[string]string{"error": "from must be a whole number"})
				return
			}
		}
		if v := r.URL.Query().Get("to"); v != "" {
			if to, err = strconv.Atoi(v); err != nil {
				writeJSON(w, 400, map[string]string{"error": "to must be a whole number"})
				return
			}
		}
		if from < 0 || to > size || from > to {
			writeJSON(w, 400, map[string]string{"error": "range out of bounds"})
			return
		}
		if to-from > maxEntriesPerPage {
			to = from + maxEntriesPerPage
		}
		e, err := s.log.Entries(from, to)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		// base64 keeps entry bytes exact, so witnesses reproduce identical leaf hashes
		out := make([]string, 0, len(e))
		budget := maxEntriesBytes
		for _, b := range e {
			if len(out) > 0 && len(b) > budget {
				break
			}
			budget -= len(b)
			out = append(out, base64.StdEncoding.EncodeToString(b))
		}
		writeJSON(w, 200, map[string]any{"from": from, "entries": out, "next": from + len(out), "size": size})
	})

	mux.HandleFunc("GET /proof/inclusion", func(w http.ResponseWriter, r *http.Request) {
		idx, e1 := strconv.Atoi(r.URL.Query().Get("index"))
		size, e2 := strconv.Atoi(r.URL.Query().Get("size"))
		if e2 != nil {
			size = s.log.Size()
		}
		if e1 != nil {
			writeJSON(w, 400, map[string]string{"error": "index required"})
			return
		}
		s.withProofSlot(w, func() {
			p, leaf, err := s.log.InclusionProof(idx, size)
			if err != nil {
				writeJSON(w, 400, map[string]string{"error": err.Error()})
				return
			}
			root, _ := s.log.RootAt(size)
			writeJSON(w, 200, map[string]any{"index": idx, "size": size, "leafHash": hex.EncodeToString(leaf), "root": hex.EncodeToString(root), "proof": hexList(p)})
		})
	})

	mux.HandleFunc("GET /proof/consistency", func(w http.ResponseWriter, r *http.Request) {
		o, e1 := strconv.Atoi(r.URL.Query().Get("old"))
		n, e2 := strconv.Atoi(r.URL.Query().Get("new"))
		if e1 != nil {
			writeJSON(w, 400, map[string]string{"error": "old required"})
			return
		}
		if e2 != nil {
			n = s.log.Size()
		}
		s.withProofSlot(w, func() {
			p, err := s.log.ConsistencyProof(o, n)
			if err != nil {
				writeJSON(w, 400, map[string]string{"error": err.Error()})
				return
			}
			or, _ := s.log.RootAt(o)
			nr, _ := s.log.RootAt(n)
			writeJSON(w, 200, map[string]any{"old": o, "new": n, "oldRoot": hex.EncodeToString(or), "newRoot": hex.EncodeToString(nr), "proof": hexList(p)})
		})
	})

	mux.HandleFunc("GET /anchors", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write(s.anchorsWithStatus())
	})

	// Standard .ots proofs, checkable with the OpenTimestamps client.
	mux.HandleFunc("GET /anchors/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if name != filepath.Base(name) || !strings.HasSuffix(name, ".ots") {
			writeJSON(w, 400, map[string]string{"error": "bad proof name"})
			return
		}
		b, err := os.ReadFile(filepath.Join(s.otsDir(), name))
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": "no such proof"})
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write(b)
	})

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	if s.limiter != nil {
		return s.limiter.limit(mux)
	}
	return mux
}

// collectCosigs asks each witness for its cosignature and keeps only those matching this head.
func (s *Server) collectCosigs(h SignedHead) []Cosignature {
	client := &http.Client{Timeout: 2 * time.Second}
	var out []Cosignature
	for _, u := range s.witnessURL {
		resp, err := client.Get(strings.TrimRight(u, "/") + "/cosign?size=" + strconv.Itoa(h.Size) + "&root=" + h.Root)
		if err != nil {
			continue
		}
		var c Cosignature
		if resp.StatusCode == 200 && json.NewDecoder(resp.Body).Decode(&c) == nil {
			pub, e1 := hex.DecodeString(c.Witness)
			sig, e2 := hex.DecodeString(c.Signature)
			if e1 == nil && e2 == nil && len(pub) == ed25519.PublicKeySize &&
				ed25519.Verify(pub, headMessage(h.Size, h.Root), sig) {
				out = append(out, c)
			}
		}
		resp.Body.Close()
	}
	return out
}

// anchorLoop appends head fingerprints to an anchors file. Simulates OpenTimestamps;
// swap for a real submitter behind the same file/endpoint contract.
func (s *Server) anchorLoop(every time.Duration) {
	for range time.Tick(every) {
		h := s.log.Head()
		rec, _ := json.Marshal(map[string]any{"size": h.Size, "root": h.Root, "anchoredAt": time.Now().UTC().Format(time.RFC3339), "chain": "simulated"})
		f, err := os.OpenFile(s.anchorPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			f.Write(append(rec, '\n'))
			f.Close()
		}
	}
}
