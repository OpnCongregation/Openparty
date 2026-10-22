package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func fill(t *testing.T, l *Log, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := l.Append([]byte(fmt.Sprintf(`{"n":%d}`, i))); err != nil {
			t.Fatal(err)
		}
	}
}

func rootHex(t *testing.T, l *Log) string {
	t.Helper()
	r, err := l.RootAt(l.Size())
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(r)
}

func appendRaw(t *testing.T, path string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		t.Fatal(err)
	}
}

// ---- F-07: durability and crash recovery ------------------------------------------------------

func TestTornFinalRecordIsDroppedAndLogContinues(t *testing.T) {
	priv := newKey(t)
	path := filepath.Join(t.TempDir(), "log.jsonl")
	l, _ := OpenLog(path, priv)
	fill(t, l, 3)
	good, _ := os.ReadFile(path)

	for name, tail := range map[string][]byte{
		"half a record, no newline":      []byte(base64.StdEncoding.EncodeToString([]byte(`{"n":3}`))[:5]),
		"whole base64 but no newline":    []byte(base64.StdEncoding.EncodeToString([]byte(`{"n":3}`))),
		"garbage with a newline (final)": []byte("%%%not base64%%%\n"),
	} {
		t.Run(name, func(t *testing.T) {
			os.WriteFile(path, good, 0o600)
			appendRaw(t, path, tail)
			r, err := OpenLog(path, priv)
			if err != nil {
				t.Fatalf("open should recover: %v", err)
			}
			if r.Size() != 3 || r.Recovered != int64(len(tail)) {
				t.Fatalf("size %d recovered %d, want 3 and %d", r.Size(), r.Recovered, len(tail))
			}
			if after, _ := os.ReadFile(path); !bytes.Equal(after, good) {
				t.Fatal("file was not cut back to the last good record")
			}
			if _, err := r.Append([]byte(`{"n":3}`)); err != nil {
				t.Fatal(err)
			}
			again, err := OpenLog(path, priv)
			if err != nil || again.Size() != 4 || again.Recovered != 0 {
				t.Fatalf("reopen after recovery: size %d err %v recovered %d", again.Size(), err, again.Recovered)
			}
			fresh, _ := OpenLog("", priv)
			fill(t, fresh, 3)
			fresh.Append([]byte(`{"n":3}`))
			if rootHex(t, again) != rootHex(t, fresh) {
				t.Fatal("root after recovery differs from a log built from the same entries")
			}
		})
	}
}

func TestDamageBeforeTheFinalRecordIsRefused(t *testing.T) {
	priv := newKey(t)
	rec := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) + "\n" }
	for name, content := range map[string]string{
		"bad record in the middle": rec("a") + "!!!\n" + rec("c"),
		"blank line in the middle": rec("a") + "\n" + rec("c"),
		"bad first of two":         "%%%\n" + rec("b"),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "log.jsonl")
			os.WriteFile(path, []byte(content), 0o600)
			before, _ := os.ReadFile(path)
			if _, err := OpenLog(path, priv); err == nil || !strings.Contains(err.Error(), "corrupt") {
				t.Fatalf("want a corruption error, got %v", err)
			}
			if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
				t.Fatal("a corrupt file must not be modified")
			}
		})
	}
}

func TestFailedAppendLeavesNothingBehind(t *testing.T) {
	priv := newKey(t)
	l, _ := OpenLog(filepath.Join(t.TempDir(), "missing-dir", "log.jsonl"), priv)
	if _, err := l.Append([]byte("x")); err == nil {
		t.Fatal("append into a missing directory should fail")
	}
	if l.Size() != 0 {
		t.Fatal("memory must not hold an entry the disk does not")
	}
}

func TestAcknowledgedAppendsSurviveReopen(t *testing.T) {
	priv := newKey(t)
	path := filepath.Join(t.TempDir(), "log.jsonl")
	l, _ := OpenLog(path, priv)
	fill(t, l, 50)
	r, err := OpenLog(path, priv)
	if err != nil || r.Size() != 50 || rootHex(t, r) != rootHex(t, l) {
		t.Fatalf("reload: size %d err %v", r.Size(), err)
	}
}

// ---- F-08: resource limits ---------------------------------------------------------------------

func hget(t *testing.T, h http.Handler, url string) (int, []byte) {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
	return w.Code, w.Body.Bytes()
}

func TestEntriesArePagedAndReassembleToTheSameRoot(t *testing.T) {
	priv := newKey(t)
	l, _ := OpenLog("", priv)
	fill(t, l, 2500)
	h := (&Server{log: l}).Routes()

	rebuilt, _ := OpenLog("", priv)
	pages := 0
	for next := 0; next < 2500; pages++ {
		code, body := hget(t, h, fmt.Sprintf("/entries?from=%d&to=2500", next))
		if code != 200 {
			t.Fatalf("page at %d: status %d", next, code)
		}
		var r struct {
			Entries []string `json:"entries"`
			Next    int      `json:"next"`
		}
		json.Unmarshal(body, &r)
		if len(r.Entries) == 0 || len(r.Entries) > maxEntriesPerPage || r.Next != next+len(r.Entries) {
			t.Fatalf("page at %d: %d entries, next %d", next, len(r.Entries), r.Next)
		}
		for _, e := range r.Entries {
			b, _ := base64.StdEncoding.DecodeString(e)
			rebuilt.Append(b)
		}
		next = r.Next
	}
	if pages != 3 {
		t.Fatalf("2500 entries should take 3 pages, took %d", pages)
	}
	if rootHex(t, rebuilt) != rootHex(t, l) {
		t.Fatal("paged copy does not reproduce the root")
	}
	// No "to" at all is also one bounded page, not the whole log.
	_, body := hget(t, h, "/entries")
	var r struct{ Entries []string }
	json.Unmarshal(body, &r)
	if len(r.Entries) != maxEntriesPerPage {
		t.Fatalf("unbounded request returned %d entries", len(r.Entries))
	}
}

func TestEntriesRejectBadRanges(t *testing.T) {
	l, _ := OpenLog("", newKey(t))
	fill(t, l, 10)
	h := (&Server{log: l}).Routes()
	for _, u := range []string{"/entries?from=-1", "/entries?from=5&to=2", "/entries?to=11", "/entries?from=x", "/entries?to=y", "/entries?from=99999999999999999999"} {
		if code, _ := hget(t, h, u); code != 400 {
			t.Errorf("%s: status %d, want 400", u, code)
		}
	}
	if code, _ := hget(t, h, "/entries?from=10&to=10"); code != 200 {
		t.Errorf("empty range at the end should be fine, got %d", code)
	}
}

func TestEntriesPageIsBoundedByBytes(t *testing.T) {
	l, _ := OpenLog("", newKey(t))
	big := bytes.Repeat([]byte("x"), maxAppendBytes)
	for i := 0; i < 6; i++ {
		l.Append(big)
	}
	h := (&Server{log: l}).Routes()
	_, body := hget(t, h, "/entries?from=0&to=6")
	var r struct {
		Entries []string
		Next    int
	}
	json.Unmarshal(body, &r)
	if len(r.Entries) != 4 || r.Next != 4 {
		t.Fatalf("a 4 MiB budget of 1 MiB entries should give 4 entries, got %d (next %d)", len(r.Entries), r.Next)
	}
}

func TestOversizedAppendIsRefusedNotTruncated(t *testing.T) {
	l, _ := OpenLog("", newKey(t))
	s := &Server{log: l, token: "tok"}
	h := s.Routes()
	post := func(n int) int {
		req := httptest.NewRequest("POST", "/append", bytes.NewReader(bytes.Repeat([]byte("a"), n)))
		req.Header.Set("Authorization", "Bearer tok")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	if c := post(maxAppendBytes + 1); c != 413 {
		t.Fatalf("oversize record: status %d, want 413", c)
	}
	if l.Size() != 0 {
		t.Fatal("a refused record must not be logged (not even a truncated one)")
	}
	if c := post(maxAppendBytes); c != 201 || l.Size() != 1 {
		t.Fatalf("a record exactly at the cap should be accepted: status %d size %d", c, l.Size())
	}
}

func TestRateLimitThrottlesReadsButNotAppend(t *testing.T) {
	l, _ := OpenLog("", newKey(t))
	s := &Server{log: l, token: "tok", limiter: newIPLimiter(60, 3)}
	h := s.Routes()
	var codes []int
	for i := 0; i < 5; i++ {
		c, _ := hget(t, h, "/healthz")
		codes = append(codes, c)
	}
	if fmt.Sprint(codes) != "[200 200 200 429 429]" {
		t.Fatalf("got %v", codes)
	}
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("POST", "/append", strings.NewReader("x"))
		req.Header.Set("Authorization", "Bearer tok")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 201 {
			t.Fatalf("append %d throttled: %d", i, w.Code)
		}
	}
}

func TestProofsAreBoundedWhenBusy(t *testing.T) {
	l, _ := OpenLog("", newKey(t))
	fill(t, l, 20)
	s := &Server{log: l}
	h := s.Routes()
	if c, _ := hget(t, h, "/proof/inclusion?index=3&size=20"); c != 200 {
		t.Fatalf("idle server: %d", c)
	}
	for i := 0; i < maxConcurrentProof; i++ {
		s.proofSem <- struct{}{}
	}
	if c, _ := hget(t, h, "/proof/consistency?old=5&new=20"); c != 503 {
		t.Fatalf("all slots busy: status %d, want 503", c)
	}
	if c, _ := hget(t, h, "/head"); c != 200 {
		t.Fatalf("a busy proof pool must not block /head: %d", c)
	}
	<-s.proofSem
	if c, _ := hget(t, h, "/proof/consistency?old=5&new=20"); c != 200 {
		t.Fatalf("slot freed: status %d", c)
	}
}

func TestWitnessSyncsALogLargerThanOnePage(t *testing.T) {
	logPriv := newKey(t)
	l, _ := OpenLog("", logPriv)
	fill(t, l, 2300)
	srv := httptest.NewServer((&Server{log: l}).Routes())
	defer srv.Close()
	w := NewWitness(newKey(t), srv.URL, hex.EncodeToString(logPriv.Public().(ed25519.PublicKey)))
	if err := w.sync(); err != nil {
		t.Fatal(err)
	}
	if w.copy.Size() != 2300 || w.root != rootHex(t, l) {
		t.Fatalf("witness holds %d entries, root match %v", w.copy.Size(), w.root == rootHex(t, l))
	}
	fill(t, l, 1500) // and a second round, which also needs a consistency proof
	if err := w.sync(); err != nil || w.copy.Size() != 3800 {
		t.Fatalf("second sync: size %d err %v", w.copy.Size(), err)
	}
}
