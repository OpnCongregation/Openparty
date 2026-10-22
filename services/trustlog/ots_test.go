package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeCalendar mimics an OpenTimestamps calendar: /digest returns a pending proof, and /timestamp/<commitment>
// answers 404 until `ready` is set, then returns a Bitcoin attestation.
type fakeCalendar struct {
	srv       *httptest.Server
	ready     atomic.Bool
	down      atomic.Bool
	upgradeAt []string
	height    int
}

func newCalendar(height int) *fakeCalendar {
	c := &fakeCalendar{height: height}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.down.Load() {
			http.Error(w, "down", 503)
			return
		}
		switch {
		case r.Method == "POST" && r.URL.Path == "/digest":
			io.Copy(io.Discard, r.Body)
			var b bytes.Buffer
			b.WriteByte(opAppend)
			putVarbytes(&b, []byte{0xaa})
			b.WriteByte(opSHA256)
			b.WriteByte(0x00)
			b.Write(tagPending)
			var uri bytes.Buffer
			putVarbytes(&uri, []byte(c.srv.URL))
			putVarbytes(&b, uri.Bytes())
			w.Write(b.Bytes())
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/timestamp/"):
			c.upgradeAt = append(c.upgradeAt, strings.TrimPrefix(r.URL.Path, "/timestamp/"))
			if !c.ready.Load() {
				http.NotFound(w, r)
				return
			}
			var b bytes.Buffer
			b.WriteByte(0x00)
			b.Write(tagBitcoin)
			var h bytes.Buffer
			putVaruint(&h, c.height)
			putVarbytes(&b, h.Bytes())
			w.Write(b.Bytes())
		default:
			http.NotFound(w, r)
		}
	}))
	return c
}

func testServer(t *testing.T, cal ...*fakeCalendar) (*Server, *Log) {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	l, _ := OpenLog("", priv)
	s := &Server{log: l, anchorPath: filepath.Join(t.TempDir(), "anchors.jsonl")}
	for _, c := range cal {
		s.calendars = append(s.calendars, c.srv.URL)
	}
	return s, l
}

func TestProofRoundTrip(t *testing.T) {
	cal := newCalendar(1)
	defer cal.srv.Close()
	digest := sha256.Sum256([]byte("head"))
	p, used := submit(http.DefaultClient, []string{cal.srv.URL}, digest[:])
	if p == nil || len(used) != 1 {
		t.Fatal("submit failed")
	}
	raw := p.bytes()
	q, err := parseProof(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(q.bytes(), raw) {
		t.Fatal("serialisation is not stable")
	}
	if st, _ := q.status(); st != "pending" {
		t.Fatalf("want pending, got %s", st)
	}
}

func TestUpgradeToBitcoinUsesCorrectCommitment(t *testing.T) {
	cal := newCalendar(800123)
	defer cal.srv.Close()
	digest := sha256.Sum256([]byte("head"))
	p, _ := submit(http.DefaultClient, []string{cal.srv.URL}, digest[:])

	if p.upgrade(http.DefaultClient, []string{cal.srv.URL}) {
		t.Fatal("should not change while the calendar says 404")
	}
	cal.ready.Store(true)
	if !p.upgrade(http.DefaultClient, []string{cal.srv.URL}) {
		t.Fatal("should upgrade once ready")
	}
	st, h := p.status()
	if st != "bitcoin" || h != 800123 {
		t.Fatalf("got %s %d", st, h)
	}
	// the calendar must be asked about sha256(digest || 0xaa)
	want := sha256.Sum256(append(append([]byte{}, digest[:]...), 0xaa))
	if got := cal.upgradeAt[len(cal.upgradeAt)-1]; got != hex.EncodeToString(want[:]) {
		t.Fatalf("asked for %s, want %x", got, want)
	}
	// still parses after the splice
	if _, err := parseProof(p.bytes()); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyConfiguredCalendarsAreContacted(t *testing.T) {
	cal := newCalendar(1)
	defer cal.srv.Close()
	digest := sha256.Sum256([]byte("x"))
	p, _ := submit(http.DefaultClient, []string{cal.srv.URL}, digest[:])
	cal.ready.Store(true)
	before := len(cal.upgradeAt)
	if p.upgrade(http.DefaultClient, []string{"https://other.example"}) {
		t.Fatal("upgraded from a calendar that was not configured")
	}
	if len(cal.upgradeAt) != before {
		t.Fatal("contacted a URL that came from a server response")
	}
}

func TestAnchorOTSEndToEnd(t *testing.T) {
	cal := newCalendar(900001)
	defer cal.srv.Close()
	s, l := testServer(t, cal)

	s.anchorOTS() // empty log: nothing to anchor
	if _, err := os.Stat(s.anchorPath); err == nil {
		t.Fatal("anchored an empty log")
	}
	l.Append([]byte("a"))
	s.anchorOTS()
	s.anchorOTS() // unchanged head: must not anchor again
	b, _ := os.ReadFile(s.anchorPath)
	if n := bytes.Count(b, []byte("\n")); n != 1 {
		t.Fatalf("want 1 anchor, got %d", n)
	}

	h := serve(s)
	defer h.Close()
	body := get(t, h.URL+"/anchors")
	if !strings.Contains(body, `"chain":"opentimestamps"`) || !strings.Contains(body, `"status":"pending"`) {
		t.Fatalf("anchors: %s", body)
	}

	cal.ready.Store(true)
	s.upgradeOTS()
	body = get(t, h.URL+"/anchors")
	if !strings.Contains(body, `"status":"bitcoin"`) || !strings.Contains(body, `"btcHeight":900001`) {
		t.Fatalf("after upgrade: %s", body)
	}

	// the proof downloads as a real .ots file; path tricks are refused
	name := proofName(1, l.Head().Root)
	resp, _ := http.Get(h.URL + "/anchors/" + name)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !bytes.HasPrefix(raw, otsMagic) {
		t.Fatalf("download: %d", resp.StatusCode)
	}
	for _, bad := range []string{"..%2Fanchors.jsonl", "x.txt", "nope.ots"} {
		r, _ := http.Get(h.URL + "/anchors/" + bad)
		r.Body.Close()
		if r.StatusCode == 200 {
			t.Fatalf("served %q", bad)
		}
	}

	l.Append([]byte("b"))
	s.anchorOTS()
	b, _ = os.ReadFile(s.anchorPath)
	if n := bytes.Count(b, []byte("\n")); n != 2 {
		t.Fatalf("grown head should anchor again, got %d", n)
	}
}

func TestCalendarDownDoesNotBreakLogging(t *testing.T) {
	cal := newCalendar(1)
	defer cal.srv.Close()
	cal.down.Store(true)
	s, l := testServer(t, cal)
	l.Append([]byte("a"))
	s.anchorOTS() // must not panic or record a fake anchor
	if _, err := os.Stat(s.anchorPath); err == nil {
		t.Fatal("recorded an anchor although no calendar accepted it")
	}
	cal.down.Store(false)
	s.anchorOTS()
	if _, err := os.Stat(s.anchorPath); err != nil {
		t.Fatal("did not retry after recovery")
	}
}

func TestOneBadCalendarIsTolerated(t *testing.T) {
	good, bad := newCalendar(1), newCalendar(1)
	defer good.srv.Close()
	defer bad.srv.Close()
	bad.down.Store(true)
	s, l := testServer(t, bad, good)
	l.Append([]byte("a"))
	s.anchorOTS()
	b, _ := os.ReadFile(s.anchorPath)
	if !bytes.Contains(b, []byte(good.srv.URL)) || bytes.Contains(b, []byte(bad.srv.URL)) {
		t.Fatalf("calendars recorded wrongly: %s", b)
	}
}

func TestGarbageProofsAreRejected(t *testing.T) {
	for _, in := range [][]byte{nil, []byte("hello"), append(append([]byte{}, otsMagic...), 0x02), append(append([]byte{}, otsMagic...), 0x01, 0x08)} {
		if _, err := parseProof(in); err == nil {
			t.Fatalf("accepted %x", in)
		}
	}
	if _, err := parseTimestamp(&reader{b: []byte{0xf0, 0x80}}, 0); err == nil {
		t.Fatal("accepted truncated varuint")
	}
}

func serve(s *Server) *httptest.Server { return httptest.NewServer(s.Routes()) }

func get(t *testing.T, url string) string {
	t.Helper()
	r, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return string(b)
}
