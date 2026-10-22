package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	oids    map[string]int // idempotency keys seen -> index of the entry that carried them
	priv    ed25519.PrivateKey
	path    string
	fs      fileOps
	// Recovered is the number of bytes of a torn final record dropped when the file was opened (0 = file was clean).
	Recovered int64
}

// oidOf extracts the idempotency key a platform put in an entry ("oid"), or "" if the entry has none. Entries are opaque
// bytes to the log; this only looks for one well-formed field.
func oidOf(b []byte) string {
	if len(b) < 8 || b[0] != '{' {
		return ""
	}
	var h struct {
		Oid string `json:"oid"`
	}
	if json.Unmarshal(b, &h) != nil || len(h.Oid) == 0 || len(h.Oid) > 64 {
		return ""
	}
	for _, c := range h.Oid {
		if !(c == '-' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return ""
		}
	}
	return h.Oid
}

func (l *Log) remember(b []byte, idx int) {
	l.entries = append(l.entries, b)
	l.leaves = append(l.leaves, hashLeaf(b))
	if o := oidOf(b); o != "" {
		if _, dup := l.oids[o]; !dup {
			l.oids[o] = idx
		}
	}
}

// Durability: Append returns success only after the record is written AND fsynced, so an acknowledged entry survives a
// crash or power loss (to the extent the storage honours fsync). A crash in the middle of an append leaves at most one
// torn final record, which OpenLog detects and drops; that record was never acknowledged. Damage anywhere before the
// final record cannot come from a torn append, so it is refused instead of repaired.
func OpenLog(path string, priv ed25519.PrivateKey) (*Log, error) {
	return openLog(osFS{}, path, priv, true)
}

// openLog reads the file. With repair=false (the verify command) it never changes the file and only reports a torn tail.
func openLog(fs fileOps, path string, priv ed25519.PrivateKey, repair bool) (*Log, error) {
	l := &Log{priv: priv, path: path, fs: fs, oids: map[string]int{}}
	if path == "" {
		return l, nil
	}
	raw, err := fs.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return nil, err
	}
	recs, good, midErr := scanRecords(raw)
	if midErr != nil {
		return nil, fmt.Errorf("%w; the %s file was left untouched. If this follows a crash or power cut and the damaged region is only unsynced tail, `trustlog repair -file %s -yes` cuts the file back to the last good record and saves the removed bytes beside it; witnesses will report it if acknowledged entries were lost", midErr, path, path)
	}
	for _, b := range recs {
		l.remember(b, len(l.entries))
	}
	if good < len(raw) {
		l.Recovered = int64(len(raw) - good)
		if !repair {
			return l, nil
		}
		log.Printf("trustlog: dropped %d bytes of an incomplete final record in %s (never acknowledged)", l.Recovered, path)
		if err := fs.Truncate(path, int64(good)); err != nil {
			return nil, fmt.Errorf("cannot repair log file: %w", err)
		}
		if err := fs.SyncPath(path); err != nil {
			return nil, err
		}
	}
	return l, nil
}

// persist appends one record and fsyncs it. On any failure the file is cut back to its previous length so a failed
// append leaves nothing behind that memory does not have.
func (l *Log) persist(data []byte) error {
	f, isNew, err := l.fs.OpenAppend(l.path)
	if err != nil {
		return err
	}
	prev, err := f.Size()
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
	if n, werr := f.Write([]byte(line)); werr != nil || n != len(line) {
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
		l.fs.SyncDir(filepath.Dir(l.path))
	}
	return nil
}

// AppendOnce appends data unless an entry with the same idempotency key ("oid") is already in the log, in which case it
// writes nothing and returns that entry's index with dup=true. This is what makes the platform's outbox safe to retry.
func (l *Log) AppendOnce(data []byte) (idx int, dup bool, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if o := oidOf(data); o != "" {
		if i, seen := l.oids[o]; seen {
			return i, true, nil
		}
	}
	if l.path != "" {
		if err := l.persist(data); err != nil {
			return 0, false, err
		}
	}
	l.remember(append([]byte(nil), data...), len(l.entries))
	return len(l.entries) - 1, false, nil
}

func (l *Log) Append(data []byte) (int, error) {
	idx, _, err := l.AppendOnce(data)
	return idx, err
}

// AppendAlways appends without the idempotency check. A witness uses it: its copy must be entry-for-entry what the log serves.
func (l *Log) AppendAlways(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.path != "" {
		if err := l.persist(data); err != nil {
			return 0, err
		}
	}
	l.remember(append([]byte(nil), data...), len(l.entries))
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

// scanRecords reads newline-terminated base64 records from the start. It returns the records it could read and how many
// bytes they cover. midErr is set when the first unreadable record is NOT the last thing in the file: a torn append can
// only damage the final record, so anything else is corruption, which is refused rather than silently repaired.
func scanRecords(raw []byte) (recs [][]byte, good int, midErr error) {
	for good < len(raw) {
		nl := bytes.IndexByte(raw[good:], '\n')
		if nl < 0 {
			return recs, good, nil // unterminated tail: a write that never finished
		}
		b, derr := base64.StdEncoding.DecodeString(string(raw[good : good+nl]))
		if derr == nil && nl == 0 {
			derr = errors.New("empty record") // Append never writes one
		}
		if derr != nil {
			if good+nl+1 == len(raw) {
				return recs, good, nil // undecodable FINAL record: also a torn write
			}
			return recs, good, fmt.Errorf("corrupt log file at byte %d (not the final record, so not a torn write): %v", good, derr)
		}
		recs = append(recs, b)
		good += nl + 1
	}
	return recs, good, nil
}
