package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
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
	// Recovered is the number of bytes of a torn final record dropped when the file was opened (0 = file was clean).
	Recovered int64
}

// Durability: Append returns success only after the record is written AND fsynced, so an acknowledged entry survives a
// crash or power loss (to the extent the storage honours fsync). A crash in the middle of an append leaves at most one
// torn final record, which OpenLog detects and drops; that record was never acknowledged. Damage anywhere before the
// final record cannot come from a torn append, so it is refused instead of repaired.
func OpenLog(path string, priv ed25519.PrivateKey) (*Log, error) {
	l := &Log{priv: priv, path: path}
	if path == "" {
		return l, nil
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return nil, err
	}
	good := 0 // bytes of fully valid, newline-terminated records
	for good < len(raw) {
		nl := bytes.IndexByte(raw[good:], '\n')
		if nl < 0 {
			break // unterminated tail: a write that never finished
		}
		b, derr := base64.StdEncoding.DecodeString(string(raw[good : good+nl]))
		if derr == nil && nl == 0 {
			derr = errors.New("empty record") // Append never writes one
		}
		if derr != nil {
			if good+nl+1 == len(raw) {
				break // undecodable FINAL record: also a torn write
			}
			return nil, fmt.Errorf("corrupt log file at byte %d (not the final record, so not a torn write): %w", good, derr)
		}
		l.entries = append(l.entries, b)
		l.leaves = append(l.leaves, hashLeaf(b))
		good += nl + 1
	}
	if good < len(raw) {
		l.Recovered = int64(len(raw) - good)
		log.Printf("trustlog: dropped %d bytes of an incomplete final record in %s (never acknowledged)", l.Recovered, path)
		if err := os.Truncate(path, int64(good)); err != nil {
			return nil, fmt.Errorf("cannot repair log file: %w", err)
		}
		if err := syncFile(path); err != nil {
			return nil, err
		}
	}
	return l, nil
}

func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// syncDir makes a newly created file's directory entry durable. Not supported on every OS (e.g. Windows), so best effort.
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}

// persist appends one record and fsyncs it. On any failure the file is cut back to its previous length so a failed
// append leaves nothing behind that memory does not have.
func (l *Log) persist(data []byte) error {
	_, statErr := os.Stat(l.path)
	isNew := errors.Is(statErr, os.ErrNotExist)
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	prev, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		f.Close()
		return err
	}
	rollback := func(cause error) error {
		f.Truncate(prev)
		f.Close()
		return cause
	}
	line := base64.StdEncoding.EncodeToString(data) + "\n"
	if n, werr := f.WriteString(line); werr != nil || n != len(line) {
		if werr == nil {
			werr = io.ErrShortWrite
		}
		return rollback(werr)
	}
	if serr := f.Sync(); serr != nil {
		return rollback(serr)
	}
	if cerr := f.Close(); cerr != nil {
		return cerr
	}
	if isNew {
		syncDir(filepath.Dir(l.path))
	}
	return nil
}

func (l *Log) Append(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.path != "" {
		if err := l.persist(data); err != nil {
			return 0, err
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
