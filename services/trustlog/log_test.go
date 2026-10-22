package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func newLog(t *testing.T, n int) *Log {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	l, err := OpenLog("", priv)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		l.Append([]byte(fmt.Sprintf("entry-%d", i)))
	}
	return l
}

func TestInclusionProofsAllSizes(t *testing.T) {
	for size := 1; size <= 33; size++ {
		l := newLog(t, size)
		root, _ := l.RootAt(size)
		for i := 0; i < size; i++ {
			p, leaf, err := l.InclusionProof(i, size)
			if err != nil {
				t.Fatal(err)
			}
			if err := verifyInclusion(leaf, i, size, p, root); err != nil {
				t.Fatalf("size %d index %d: %v", size, i, err)
			}
		}
	}
}

func TestInclusionRejectsWrongLeaf(t *testing.T) {
	l := newLog(t, 10)
	root, _ := l.RootAt(10)
	p, _, _ := l.InclusionProof(3, 10)
	if err := verifyInclusion(hashLeaf([]byte("forged")), 3, 10, p, root); err == nil {
		t.Fatal("forged leaf accepted")
	}
}

func TestConsistencyProofsAllPairs(t *testing.T) {
	l := newLog(t, 24)
	for m := 1; m <= 24; m++ {
		for n := m; n <= 24; n++ {
			p, err := l.ConsistencyProof(m, n)
			if err != nil {
				t.Fatal(err)
			}
			or, _ := l.RootAt(m)
			nr, _ := l.RootAt(n)
			if err := verifyConsistency(m, n, or, nr, p); err != nil {
				t.Fatalf("m=%d n=%d: %v", m, n, err)
			}
		}
	}
}

// Tamper test: a log that rewrites history cannot produce a valid consistency proof
// against the root a witness already holds.
func TestRewrittenHistoryDetected(t *testing.T) {
	honest := newLog(t, 8)
	oldRoot, _ := honest.RootAt(8)

	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	evil, _ := OpenLog("", priv)
	for i := 0; i < 12; i++ {
		d := fmt.Sprintf("entry-%d", i)
		if i == 2 {
			d = "entry-2-EDITED"
		}
		evil.Append([]byte(d))
	}
	p, _ := evil.ConsistencyProof(8, 12)
	newRoot, _ := evil.RootAt(12)
	if err := verifyConsistency(8, 12, oldRoot, newRoot, p); err == nil {
		t.Fatal("rewritten history passed consistency check")
	}
}

func TestSignedHeadVerifies(t *testing.T) {
	l := newLog(t, 5)
	h := l.Head()
	pub, _ := hex.DecodeString(h.LogKey)
	sig, _ := hex.DecodeString(h.Signature)
	if !ed25519.Verify(pub, headMessage(h.Size, h.Root), sig) {
		t.Fatal("head signature invalid")
	}
	if ed25519.Verify(pub, headMessage(h.Size+1, h.Root), sig) {
		t.Fatal("signature valid for wrong size")
	}
}

func TestPersistenceReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	l, _ := OpenLog(path, priv)
	l.Append([]byte(`{"a":1}`))
	l.Append([]byte("two"))
	r1, _ := l.RootAt(2)
	l2, err := OpenLog(path, priv)
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := l2.RootAt(l2.Size())
	if l2.Size() != 2 || hex.EncodeToString(r1) != hex.EncodeToString(r2) {
		t.Fatal("reload mismatch")
	}
	os.Remove(path)
}
