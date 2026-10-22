package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OpenTimestamps anchoring. The log head's root (32 bytes) is sent to public calendar servers, which batch
// it into a Bitcoin transaction. Only the hash leaves this machine. The result is a standard .ots proof
// that anyone can check with the `ots` client. Format reference: the OpenTimestamps python library.

var otsMagic = []byte("\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94")

var (
	tagBitcoin = []byte{0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01}
	tagPending = []byte{0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e}
)

const (
	opSHA256  = 0x08
	opAppend  = 0xf0
	opPrepend = 0xf1
	maxProof  = 1 << 20
)

// DefaultCalendars are public servers run by independent parties; override with OTS_CALENDARS.
var DefaultCalendars = []string{
	"https://alice.btc.calendar.opentimestamps.org",
	"https://bob.btc.calendar.opentimestamps.org",
	"https://finney.calendar.eternitywall.com",
}

// node is one item of a timestamp: an operation with a sub-timestamp, or an attestation.
type node struct {
	attest  bool
	tag     []byte // attestation type
	payload []byte // attestation payload (raw, still wrapped for pending: varbytes(uri))
	op      byte
	arg     []byte
	kids    []*node
}

type reader struct {
	b []byte
	i int
}

func (r *reader) byte() (byte, error) {
	if r.i >= len(r.b) {
		return 0, io.ErrUnexpectedEOF
	}
	c := r.b[r.i]
	r.i++
	return c, nil
}

func (r *reader) take(n int) ([]byte, error) {
	if n < 0 || r.i+n > len(r.b) {
		return nil, io.ErrUnexpectedEOF
	}
	out := r.b[r.i : r.i+n]
	r.i += n
	return out, nil
}

func (r *reader) varuint() (int, error) {
	v, shift := 0, 0
	for {
		c, err := r.byte()
		if err != nil {
			return 0, err
		}
		v |= int(c&0x7f) << shift
		if c&0x80 == 0 {
			return v, nil
		}
		shift += 7
		if shift > 28 {
			return 0, errors.New("varuint too long")
		}
	}
}

func (r *reader) varbytes() ([]byte, error) {
	n, err := r.varuint()
	if err != nil {
		return nil, err
	}
	return r.take(n)
}

// parseTimestamp reads a sequence of items: every item but the last is preceded by 0xff.
func parseTimestamp(r *reader, depth int) ([]*node, error) {
	if depth > 64 {
		return nil, errors.New("timestamp too deep")
	}
	var items []*node
	for {
		t, err := r.byte()
		if err != nil {
			return nil, err
		}
		more := t == 0xff
		if more {
			if t, err = r.byte(); err != nil {
				return nil, err
			}
		}
		n, err := parseItem(r, t, depth)
		if err != nil {
			return nil, err
		}
		items = append(items, n)
		if !more {
			return items, nil
		}
	}
}

func parseItem(r *reader, t byte, depth int) (*node, error) {
	if t == 0x00 {
		tag, err := r.take(8)
		if err != nil {
			return nil, err
		}
		payload, err := r.varbytes()
		if err != nil {
			return nil, err
		}
		return &node{attest: true, tag: append([]byte(nil), tag...), payload: append([]byte(nil), payload...)}, nil
	}
	n := &node{op: t}
	switch t {
	case opAppend, opPrepend:
		arg, err := r.varbytes()
		if err != nil {
			return nil, err
		}
		n.arg = append([]byte(nil), arg...)
	case opSHA256:
	default:
		return nil, fmt.Errorf("unsupported operation 0x%02x", t)
	}
	kids, err := parseTimestamp(r, depth+1)
	if err != nil {
		return nil, err
	}
	n.kids = kids
	return n, nil
}

func putVaruint(w *bytes.Buffer, v int) {
	for v >= 0x80 {
		w.WriteByte(byte(v&0x7f) | 0x80)
		v >>= 7
	}
	w.WriteByte(byte(v))
}

func putVarbytes(w *bytes.Buffer, b []byte) {
	putVaruint(w, len(b))
	w.Write(b)
}

func writeTimestamp(w *bytes.Buffer, items []*node) {
	for i, n := range items {
		if i < len(items)-1 {
			w.WriteByte(0xff)
		}
		if n.attest {
			w.WriteByte(0x00)
			w.Write(n.tag)
			putVarbytes(w, n.payload)
			continue
		}
		w.WriteByte(n.op)
		if n.op == opAppend || n.op == opPrepend {
			putVarbytes(w, n.arg)
		}
		writeTimestamp(w, n.kids)
	}
}

func apply(n *node, msg []byte) []byte {
	switch n.op {
	case opAppend:
		return append(append([]byte(nil), msg...), n.arg...)
	case opPrepend:
		return append(append([]byte(nil), n.arg...), msg...)
	default: // opSHA256
		h := sha256.Sum256(msg)
		return h[:]
	}
}

// otsProof is a digest plus the tree that links it to attestations.
type otsProof struct {
	digest []byte
	items  []*node
}

func parseProof(b []byte) (*otsProof, error) {
	if !bytes.HasPrefix(b, otsMagic) {
		return nil, errors.New("not an .ots file")
	}
	r := &reader{b: b, i: len(otsMagic)}
	if v, err := r.varuint(); err != nil || v != 1 {
		return nil, errors.New("unsupported .ots version")
	}
	if op, err := r.byte(); err != nil || op != opSHA256 {
		return nil, errors.New("unsupported file hash")
	}
	d, err := r.take(32)
	if err != nil {
		return nil, err
	}
	items, err := parseTimestamp(r, 0)
	if err != nil {
		return nil, err
	}
	return &otsProof{digest: append([]byte(nil), d...), items: items}, nil
}

func (p *otsProof) bytes() []byte {
	var w bytes.Buffer
	w.Write(otsMagic)
	putVaruint(&w, 1)
	w.WriteByte(opSHA256)
	w.Write(p.digest)
	writeTimestamp(&w, p.items)
	return w.Bytes()
}

func pendingURI(n *node) (string, bool) {
	if !n.attest || !bytes.Equal(n.tag, tagPending) {
		return "", false
	}
	r := &reader{b: n.payload}
	u, err := r.varbytes()
	return string(u), err == nil
}

func bitcoinHeight(n *node) (int, bool) {
	if !n.attest || !bytes.Equal(n.tag, tagBitcoin) {
		return 0, false
	}
	h, err := (&reader{b: n.payload}).varuint()
	return h, err == nil
}

// status reports whether the proof has a Bitcoin attestation (and its lowest block height) or is still pending.
func (p *otsProof) status() (string, int) {
	best, pending := 0, false
	var walk func([]*node)
	walk = func(items []*node) {
		for _, n := range items {
			if h, ok := bitcoinHeight(n); ok && (best == 0 || h < best) {
				best = h
			}
			if _, ok := pendingURI(n); ok {
				pending = true
			}
			walk(n.kids)
		}
	}
	walk(p.items)
	switch {
	case best > 0:
		return "bitcoin", best
	case pending:
		return "pending", 0
	}
	return "unknown", 0
}

// upgrade asks each pending calendar for its finished proof and splices it in. It returns true if anything changed.
func (p *otsProof) upgrade(c *http.Client, allowed []string) bool {
	changed := false
	var walk func(items []*node, msg []byte) []*node
	walk = func(items []*node, msg []byte) []*node {
		var out []*node
		for _, n := range items {
			if uri, ok := pendingURI(n); ok {
				if frag := fetchUpgrade(c, allowed, uri, msg); frag != nil {
					changed = true
					out = append(out, frag...)
					continue
				}
				out = append(out, n)
				continue
			}
			if !n.attest {
				n.kids = walk(n.kids, apply(n, msg))
			}
			out = append(out, n)
		}
		return out
	}
	p.items = walk(p.items, p.digest)
	return changed
}

func calendarAllowed(allowed []string, uri string) bool {
	u := strings.TrimRight(uri, "/")
	for _, a := range allowed {
		if strings.TrimRight(a, "/") == u {
			return true
		}
	}
	return false
}

// fetchUpgrade only talks to calendars we were configured with, never to a URL a server handed us.
func fetchUpgrade(c *http.Client, allowed []string, uri string, commitment []byte) []*node {
	if !calendarAllowed(allowed, uri) {
		return nil
	}
	req, _ := http.NewRequest("GET", strings.TrimRight(uri, "/")+"/timestamp/"+hex.EncodeToString(commitment), nil)
	req.Header.Set("Accept", "application/vnd.opentimestamps.v1")
	resp, err := c.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil // 404 means not yet in a Bitcoin block
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxProof))
	if err != nil {
		return nil
	}
	items, err := parseTimestamp(&reader{b: b}, 0)
	if err != nil {
		log.Printf("ots: bad upgrade from %s: %v", uri, err)
		return nil
	}
	return items
}

// submit sends a digest to every calendar and combines the fragments that come back into one proof.
func submit(c *http.Client, calendars []string, digest []byte) (*otsProof, []string) {
	p := &otsProof{digest: digest}
	var used []string
	for _, cal := range calendars {
		req, _ := http.NewRequest("POST", strings.TrimRight(cal, "/")+"/digest", bytes.NewReader(digest))
		req.Header.Set("Accept", "application/vnd.opentimestamps.v1")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := c.Do(req)
		if err != nil {
			log.Printf("ots: %s unreachable: %v", cal, err)
			continue
		}
		b, rerr := io.ReadAll(io.LimitReader(resp.Body, maxProof))
		resp.Body.Close()
		if rerr != nil || resp.StatusCode != 200 {
			log.Printf("ots: %s answered %d", cal, resp.StatusCode)
			continue
		}
		items, err := parseTimestamp(&reader{b: b}, 0)
		if err != nil {
			log.Printf("ots: %s sent an unreadable proof: %v", cal, err)
			continue
		}
		p.items = append(p.items, items...)
		used = append(used, cal)
	}
	if len(used) == 0 {
		return nil, nil
	}
	return p, used
}

// ---- wiring into the server ------------------------------------------------------------------

func (s *Server) otsDir() string { return filepath.Join(filepath.Dir(s.anchorPath), "ots") }

func proofName(size int, root string) string { return fmt.Sprintf("%d-%s.ots", size, root) }

func (s *Server) lastOTSSize() int {
	b, err := os.ReadFile(s.anchorPath)
	if err != nil {
		return 0
	}
	last := 0
	for _, line := range bytes.Split(b, []byte("\n")) {
		var r struct {
			Size  int    `json:"size"`
			Chain string `json:"chain"`
		}
		if json.Unmarshal(line, &r) == nil && r.Chain == "opentimestamps" {
			last = r.Size
		}
	}
	return last
}

// anchorOTS submits the current head once if it has grown since the last anchor.
func (s *Server) anchorOTS() {
	h := s.log.Head()
	if h.Size == 0 || h.Size == s.lastOTSSize() {
		return
	}
	digest, err := hex.DecodeString(h.Root)
	if err != nil || len(digest) != 32 {
		return
	}
	p, used := submit(s.http(), s.calendars, digest)
	if p == nil {
		log.Printf("ots: no calendar accepted size %d; will retry next interval", h.Size)
		return
	}
	os.MkdirAll(s.otsDir(), 0o700)
	name := proofName(h.Size, h.Root)
	if err := os.WriteFile(filepath.Join(s.otsDir(), name), p.bytes(), 0o600); err != nil {
		log.Printf("ots: cannot save proof: %v", err)
		return
	}
	rec, _ := json.Marshal(map[string]any{"size": h.Size, "root": h.Root, "anchoredAt": time.Now().UTC().Format(time.RFC3339),
		"chain": "opentimestamps", "proof": name, "calendars": used})
	if f, err := os.OpenFile(s.anchorPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		f.Write(append(rec, '\n'))
		f.Close()
	}
}

// upgradeOTS refreshes every proof that is still pending.
func (s *Server) upgradeOTS() {
	files, _ := filepath.Glob(filepath.Join(s.otsDir(), "*.ots"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		p, err := parseProof(b)
		if err != nil {
			continue
		}
		if st, _ := p.status(); st == "bitcoin" {
			continue
		}
		if p.upgrade(s.http(), s.calendars) {
			os.WriteFile(f, p.bytes(), 0o600)
		}
	}
}

func (s *Server) http() *http.Client {
	if s.client != nil {
		return s.client
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (s *Server) otsLoop(every, upgradeEvery time.Duration) {
	s.anchorOTS()
	a, u := time.NewTicker(every), time.NewTicker(upgradeEvery)
	for {
		select {
		case <-a.C:
			s.anchorOTS()
		case <-u.C:
			s.upgradeOTS()
		}
	}
}

// anchorsWithStatus returns anchors.jsonl with each OpenTimestamps line enriched with live proof status.
func (s *Server) anchorsWithStatus() []byte {
	b, _ := os.ReadFile(s.anchorPath)
	var out bytes.Buffer
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil || rec["chain"] != "opentimestamps" {
			out.Write(line)
			out.WriteByte('\n')
			continue
		}
		rec["status"] = "unknown"
		if name, ok := rec["proof"].(string); ok && name == filepath.Base(name) {
			if pb, err := os.ReadFile(filepath.Join(s.otsDir(), name)); err == nil {
				if p, err := parseProof(pb); err == nil {
					st, h := p.status()
					rec["status"] = st
					if h > 0 {
						rec["btcHeight"] = h
					}
				}
			}
		}
		enc, _ := json.Marshal(rec)
		out.Write(enc)
		out.WriteByte('\n')
	}
	return out.Bytes()
}
