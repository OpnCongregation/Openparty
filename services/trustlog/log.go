package main

import (
	"bufio"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// SignedHead is a log state (size + root) signed by the log operator key.
type SignedHead struct {
	Size      int    `json:"size"`
	Root      string `json:"root"`
	Time      string `json:"time"`
	Signature string `json:"signature"`
	LogKey    string `json:"logKey"`
}

// Cosignature is a witness's signature over the same head.
type Cosignature struct {
	Witness   string `json:"witness"` // hex public key
	Signature string `json:"signature"`
}

func headMessage(size int, root string) []byte {
	return []byte(fmt.Sprintf("openparty-log/v1\n%d\n%s", size, root))
}

type Log struct {
	mu      sync.RWMutex
	entries [][]byte
	leaves  [][]byte
	priv    ed25519.PrivateKey
	path    string
}

func OpenLog(path string, priv ed25519.PrivateKey) (*Log, error) {
	l := &Log{priv: priv, path: path}
	if path == "" {
		return l, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		b, err := base64.StdEncoding.DecodeString(sc.Text())
		if err != nil {
			return nil, fmt.Errorf("corrupt log file: %w", err)
		}
		l.entries = append(l.entries, b)
		l.leaves = append(l.leaves, hashLeaf(b))
	}
	return l, sc.Err()
}

func (l *Log) Append(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.path != "" {
		f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return 0, err
		}
		_, werr := f.WriteString(base64.StdEncoding.EncodeToString(data) + "\n")
		cerr := f.Close()
		if werr != nil {
			return 0, werr
		}
		if cerr != nil {
			return 0, cerr
		}
	}
	l.entries = append(l.entries, append([]byte(nil), data...))
	l.leaves = append(l.leaves, hashLeaf(data))
	return len(l.entries) - 1, nil
}

func (l *Log) Size() int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return len(l.entries)
}

func (l *Log) Head() SignedHead {
	l.mu.RLock()
	defer l.mu.RUnlock()
	root := hex.EncodeToString(rootOf(l.leaves))
	size := len(l.leaves)
	sig := ed25519.Sign(l.priv, headMessage(size, root))
	return SignedHead{
		Size:      size,
		Root:      root,
		Time:      time.Now().UTC().Format(time.RFC3339),
		Signature: hex.EncodeToString(sig),
		LogKey:    hex.EncodeToString(l.priv.Public().(ed25519.PublicKey)),
	}
}

// RootAt returns the root hash for the first size entries.
func (l *Log) RootAt(size int) ([]byte, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if size < 0 || size > len(l.leaves) {
		return nil, errors.New("size out of range")
	}
	return rootOf(l.leaves[:size]), nil
}

func (l *Log) Entries(from, to int) ([][]byte, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if from < 0 || to > len(l.entries) || from > to {
		return nil, errors.New("range out of bounds")
	}
	return l.entries[from:to], nil
}

func (l *Log) InclusionProof(index, size int) ([][]byte, []byte, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if size < 1 || size > len(l.leaves) || index < 0 || index >= size {
		return nil, nil, errors.New("index or size out of range")
	}
	return inclusionProof(index, l.leaves[:size]), l.leaves[index], nil
}

func (l *Log) ConsistencyProof(oldSize, newSize int) ([][]byte, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if oldSize < 1 || newSize > len(l.leaves) || oldSize > newSize {
		return nil, errors.New("sizes out of range")
	}
	return consistencyProof(oldSize, l.leaves[:newSize]), nil
}
