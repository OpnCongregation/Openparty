package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// memFS is a disk that tells the truth about durability: bytes are volatile until Sync, a new file's directory entry is
// volatile until SyncDir, and crash() throws away everything volatile (optionally keeping a random piece of the unsynced
// tail, as a real power cut can). If the log acknowledged a write it had not synced, or forgot to sync the directory,
// these tests lose data. This checks the log's ordering of writes and syncs; it does not check any real disk.
type memFS struct {
	files map[string]*memFile
	// failSync / failWrite make the next call fail once.
	failSync, failWrite bool
}

type memFile struct {
	durable, volatile []byte
	linked            bool // directory entry is durable
	inDir             bool // exists in the volatile view
}

func newMemFS() *memFS { return &memFS{files: map[string]*memFile{}} }

func (m *memFS) ReadFile(name string) ([]byte, error) {
	f, ok := m.files[name]
	if !ok || !f.inDir {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), f.volatile...), nil
}

func (m *memFS) OpenAppend(name string) (appendFile, bool, error) {
	f, ok := m.files[name]
	created := !ok || !f.inDir
	if created {
		f = &memFile{inDir: true}
		m.files[name] = f
	}
	return &memHandle{fs: m, f: f}, created, nil
}

func (m *memFS) Truncate(name string, size int64) error {
	f, ok := m.files[name]
	if !ok {
		return os.ErrNotExist
	}
	f.volatile = f.volatile[:size]
	return nil
}

func (m *memFS) SyncPath(name string) error {
	if f, ok := m.files[name]; ok {
		f.durable = append([]byte(nil), f.volatile...)
	}
	return nil
}

func (m *memFS) SyncDir(string) {
	for _, f := range m.files {
		if f.inDir {
			f.linked = true
		}
	}
}

type memHandle struct {
	fs *memFS
	f  *memFile
}

func (h *memHandle) Size() (int64, error) { return int64(len(h.f.volatile)), nil }
func (h *memHandle) Write(p []byte) (int, error) {
	if h.fs.failWrite {
		h.fs.failWrite = false
		h.f.volatile = append(h.f.volatile, p[:len(p)/2]...) // a short write
		return len(p) / 2, nil
	}
	h.f.volatile = append(h.f.volatile, p...)
	return len(p), nil
}
func (h *memHandle) Sync() error {
	if h.fs.failSync {
		h.fs.failSync = false
		return errors.New("injected sync failure")
	}
	h.f.durable = append([]byte(nil), h.f.volatile...)
	return nil
}
func (h *memHandle) Truncate(size int64) error { h.f.volatile = h.f.volatile[:size]; return nil }
func (h *memHandle) Close() error              { return nil }

type crashMode int

const (
	dropUnsynced crashMode = iota // only what was synced survives
	keepPrefix                    // plus a random prefix of the unsynced tail
	keepGarbage                   // plus random garbage after the synced data
	keepZeros                     // plus zero bytes (a file extended but not filled)
	numCrashModes
)

// crash simulates power loss: the running process vanishes and the disk keeps durable data, plus (for the nastier modes)
// something extra after it.
func (m *memFS) crash(mode crashMode, rng *rand.Rand) {
	for name, f := range m.files {
		if !f.linked {
			delete(m.files, name) // the file's directory entry never reached disk
			continue
		}
		survive := append([]byte(nil), f.durable...)
		tail := []byte{}
		if len(f.volatile) > len(f.durable) {
			tail = f.volatile[len(f.durable):]
		}
		switch mode {
		case keepPrefix:
			survive = append(survive, tail[:rng.Intn(len(tail)+1)]...)
		case keepGarbage:
			// Garbage with no newline in it: the shape of a half-written record. (Garbage WITH newlines is covered
			// separately below: it cannot be told apart from corruption, so it is refused and needs `repair`.)
			g := make([]byte, 1+rng.Intn(40))
			rng.Read(g)
			for i := range g {
				if g[i] == '\n' {
					g[i] = 'x'
				}
			}
			survive = append(survive, g...)
		case keepZeros:
			survive = append(survive, make([]byte, 1+rng.Intn(40))...)
		}
		f.durable = survive
		f.volatile = append([]byte(nil), survive...)
		f.inDir = true
	}
}

func testKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
}

func payload(i int) []byte { return []byte(fmt.Sprintf(`{"n":%d,"oid":"k%d"}`, i, i)) }

func openMem(t *testing.T, fs *memFS) *Log {
	t.Helper()
	l, err := openLog(fs, "log.jsonl", testKey(), true)
	if err != nil {
		t.Fatalf("open after crash: %v", err)
	}
	return l
}

func TestPowerLossKeepsEveryAcknowledgedAppend(t *testing.T) {
	for trial := 0; trial < 400; trial++ {
		rng := rand.New(rand.NewSource(int64(trial)))
		fs := newMemFS()
		l := openMem(t, fs)
		acked := rng.Intn(12) // possibly zero: the very first append is the one that creates the file
		for i := 0; i < acked; i++ {
			if _, err := l.Append(payload(i)); err != nil {
				t.Fatal(err)
			}
		}
		// A crash in the middle of one more append: the line is written but never synced.
		inFlight := acked
		if rng.Intn(3) > 0 {
			f, _, _ := fs.OpenAppend("log.jsonl")
			line := base64.StdEncoding.EncodeToString(payload(inFlight)) + "\n"
			f.Write([]byte(line))
		}
		mode := crashMode(rng.Intn(int(numCrashModes)))
		fs.crash(mode, rng)

		r := openMem(t, fs)
		if r.Size() < acked || r.Size() > acked+1 {
			t.Fatalf("trial %d mode %d: acknowledged %d, log holds %d", trial, mode, acked, r.Size())
		}
		for i := 0; i < r.Size(); i++ {
			if !bytes.Equal(r.entries[i], payload(i)) {
				t.Fatalf("trial %d: entry %d differs after recovery", trial, i)
			}
		}
		// The log carries on, and its root equals one built from the same entries.
		n := r.Size()
		if _, err := r.Append(payload(n)); err != nil {
			t.Fatal(err)
		}
		again := openMem(t, fs)
		if again.Recovered != 0 || again.Size() != n+1 {
			t.Fatalf("trial %d: reopen after recovery: size %d recovered %d", trial, again.Size(), again.Recovered)
		}
		clean, _ := OpenLog("", testKey())
		for i := 0; i <= n; i++ {
			clean.Append(payload(i))
		}
		a, _ := again.RootAt(again.Size())
		b, _ := clean.RootAt(clean.Size())
		if !bytes.Equal(a, b) {
			t.Fatalf("trial %d: root differs from a clean rebuild", trial)
		}
	}
}

func TestFirstAppendSurvivesBecauseTheDirectoryIsSynced(t *testing.T) {
	fs := newMemFS()
	l := openMem(t, fs)
	if _, err := l.Append(payload(0)); err != nil {
		t.Fatal(err)
	}
	fs.crash(dropUnsynced, rand.New(rand.NewSource(1)))
	if r := openMem(t, fs); r.Size() != 1 {
		t.Fatalf("the first acknowledged entry was lost with its file: size %d", r.Size())
	}
}

func TestFailedSyncOrShortWriteIsNotAcknowledgedAndLeavesNothing(t *testing.T) {
	for name, inject := range map[string]func(*memFS){
		"sync fails":  func(f *memFS) { f.failSync = true },
		"short write": func(f *memFS) { f.failWrite = true },
	} {
		t.Run(name, func(t *testing.T) {
			fs := newMemFS()
			l := openMem(t, fs)
			l.Append(payload(0))
			inject(fs)
			if _, err := l.Append(payload(1)); err == nil {
				t.Fatal("append should report the failure")
			}
			if l.Size() != 1 {
				t.Fatalf("memory holds %d entries after a failed append", l.Size())
			}
			if _, err := l.Append(payload(1)); err != nil {
				t.Fatal(err)
			}
			fs.crash(keepPrefix, rand.New(rand.NewSource(2)))
			if r := openMem(t, fs); r.Size() != 2 || r.Recovered != 0 {
				t.Fatalf("after a failed append and a retry: size %d recovered %d", r.Size(), r.Recovered)
			}
		})
	}
}

func TestDamageBeforeTheFinalRecordIsRefusedEvenAfterACrash(t *testing.T) {
	fs := newMemFS()
	l := openMem(t, fs)
	for i := 0; i < 5; i++ {
		l.Append(payload(i))
	}
	f := fs.files["log.jsonl"]
	f.durable[3] = '!' // a flipped byte inside the first record, long since synced
	f.volatile = append([]byte(nil), f.durable...)
	if _, err := openLog(fs, "log.jsonl", testKey(), true); err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("want a corruption error, got %v", err)
	}
}

func TestVerifyDoesNotRepairAndReportsLostAcknowledgedData(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/log.jsonl"
	l, _ := OpenLog(path, testKey())
	for i := 0; i < 4; i++ {
		l.Append(payload(i))
	}
	appendRaw(t, path, []byte("AAAA")) // torn tail
	before, _ := os.ReadFile(path)

	ack := dir + "/acked.txt"
	os.WriteFile(ack, []byte("0\n1\n3\n"), 0o600)
	if code := runVerify([]string{"-file", path, "-acked", ack}); code != 0 {
		t.Fatalf("verify should pass when all acknowledged entries are present (exit %d)", code)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Fatal("verify must not modify the file")
	}
	os.WriteFile(ack, []byte("0\n9\n"), 0o600)
	if code := runVerify([]string{"-file", path, "-acked", ack}); code != 1 {
		t.Fatalf("verify should fail when an acknowledged entry is missing (exit %d)", code)
	}
}

// ---- Idempotency key ----------------------------------------------------------------------------------------------

func TestAppendOnceIgnoresARepeatedOid(t *testing.T) {
	path := t.TempDir() + "/log.jsonl"
	l, _ := OpenLog(path, testKey())
	a := []byte(`{"type":"x","oid":"abc-1","at":"t1"}`)
	i1, dup1, _ := l.AppendOnce(a)
	i2, dup2, _ := l.AppendOnce([]byte(`{"type":"x","oid":"abc-1","at":"t2"}`))
	l.Append([]byte(`{"type":"y"}`)) // no oid: always appended
	l.Append([]byte(`{"type":"y"}`))
	if dup1 || !dup2 || i1 != i2 || l.Size() != 3 {
		t.Fatalf("dup1=%v dup2=%v i1=%d i2=%d size=%d", dup1, dup2, i1, i2, l.Size())
	}
	// The key is remembered across a restart.
	r, _ := OpenLog(path, testKey())
	if i, dup, _ := r.AppendOnce(a); !dup || i != i1 || r.Size() != 3 {
		t.Fatalf("after reopen: idx %d dup %v size %d", i, dup, r.Size())
	}
	// Odd keys are not treated as keys.
	for _, bad := range []string{`{"oid":""}`, `{"oid":"a b"}`, `{"oid":"` + strings.Repeat("x", 65) + `"}`, `{"oid":5}`} {
		if oidOf([]byte(bad)) != "" {
			t.Errorf("%s should not count as an idempotency key", bad)
		}
	}
}

func TestAppendHandlerReturns200ForARepeatedOid(t *testing.T) {
	l, _ := OpenLog("", testKey())
	s := &Server{log: l, token: "tok"}
	h := s.Routes()
	post := func(body string) int {
		req := newReq("POST", "/append", body)
		req.Header.Set("Authorization", "Bearer tok")
		w := statusOf(h, req)
		return w
	}
	if c := post(`{"type":"x","oid":"o-1"}`); c != 201 {
		t.Fatalf("first: %d", c)
	}
	if c := post(`{"type":"x","oid":"o-1"}`); c != 200 {
		t.Fatalf("repeat: %d", c)
	}
	if l.Size() != 1 {
		t.Fatalf("size %d", l.Size())
	}
}

func TestWitnessCopyKeepsEveryEntryEvenWithRepeatedOids(t *testing.T) {
	// A witness must hold exactly what the log serves. AppendAlways does not apply the idempotency check.
	l, _ := OpenLog("", testKey())
	l.AppendAlways([]byte(`{"oid":"same-1","n":1}`))
	l.AppendAlways([]byte(`{"oid":"same-1","n":2}`))
	if l.Size() != 2 {
		t.Fatalf("size %d", l.Size())
	}
}

// ---- Limiter persistence ------------------------------------------------------------------------------------------

func TestLimiterStateSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	a := newIPLimiter(60, 3)
	for i := 0; i < 3; i++ {
		a.allow("1.2.3.4")
	}
	if a.allow("1.2.3.4") {
		t.Fatal("bucket should be empty")
	}
	flush := a.persist(dir, 1<<40)
	flush()

	b := newIPLimiter(60, 3) // the "restarted" process
	b.persist(dir, 1<<40)
	if b.allow("1.2.3.4") {
		t.Fatal("a restart must not hand back a full allowance")
	}
	if !b.allow("5.6.7.8") {
		t.Fatal("other addresses are unaffected")
	}
	// Time that passed while the process was down refills the bucket.
	c := newIPLimiter(60, 3)
	c.load(dir + "/ratelimit.json")
	for _, bk := range c.buckets {
		bk.last = bk.last.Add(-10 * 1e9) // ten seconds ago -> 10 tokens at 1/s
	}
	if !c.allow("1.2.3.4") {
		t.Fatal("tokens should have refilled with elapsed time")
	}
	// Garbage in the file is ignored, not fatal.
	os.WriteFile(dir+"/ratelimit.json", []byte("not json"), 0o600)
	newIPLimiter(60, 3).load(dir + "/ratelimit.json")
}

func TestGarbageWithNewlinesAfterACrashIsRefusedAndRepairable(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/log.jsonl"
	l, _ := OpenLog(path, testKey())
	for i := 0; i < 3; i++ {
		l.Append(payload(i))
	}
	good, _ := os.ReadFile(path)
	appendRaw(t, path, []byte("%%junk%%\nmore junk\nand more"))
	damaged, _ := os.ReadFile(path)

	_, err := OpenLog(path, testKey())
	if err == nil || !strings.Contains(err.Error(), "trustlog repair") {
		t.Fatalf("want a refusal that names the repair command, got %v", err)
	}
	if now, _ := os.ReadFile(path); !bytes.Equal(now, damaged) {
		t.Fatal("a refused open must not touch the file")
	}
	if code := runRepair([]string{"-file", path}); code != 1 {
		t.Fatalf("repair without -yes must not run (exit %d)", code)
	}
	if now, _ := os.ReadFile(path); !bytes.Equal(now, damaged) {
		t.Fatal("repair without -yes changed the file")
	}
	if code := runRepair([]string{"-file", path, "-yes"}); code != 0 {
		t.Fatalf("repair exit %d", code)
	}
	if now, _ := os.ReadFile(path); !bytes.Equal(now, good) {
		t.Fatal("repair should leave exactly the good records")
	}
	saved, _ := filepath.Glob(path + ".removed-*")
	if len(saved) != 1 {
		t.Fatalf("the removed bytes must be saved: %v", saved)
	}
	if b, _ := os.ReadFile(saved[0]); !bytes.Equal(b, damaged[len(good):]) {
		t.Fatal("saved bytes differ from what was removed")
	}
	if r, err := OpenLog(path, testKey()); err != nil || r.Size() != 3 {
		t.Fatalf("after repair: %v size", err)
	}
}
