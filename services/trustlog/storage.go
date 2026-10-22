package main

import (
	"errors"
	"os"
	"path/filepath"
)

// fileOps is the only way the log touches disk. It exists so tests can replace the disk with one that loses everything not
// yet synced (a simulated power cut) and check that the log syncs in the right order. Production uses osFS.
type fileOps interface {
	ReadFile(name string) ([]byte, error)
	// OpenAppend opens (creating if needed) a file for appending. created reports whether this call created it.
	OpenAppend(name string) (f appendFile, created bool, err error)
	// Truncate cuts the file to size. The cut is durable only after SyncPath.
	Truncate(name string, size int64) error
	SyncPath(name string) error
	// SyncDir makes a newly created file's directory entry durable (best effort where the OS cannot).
	SyncDir(dir string)
}

type appendFile interface {
	Size() (int64, error)
	Write(p []byte) (int, error)
	// Sync makes everything written so far durable.
	Sync() error
	Truncate(size int64) error
	Close() error
}

type osFS struct{}

func (osFS) ReadFile(name string) ([]byte, error) { return os.ReadFile(name) }

func (osFS) OpenAppend(name string) (appendFile, bool, error) {
	_, statErr := os.Stat(name)
	created := errors.Is(statErr, os.ErrNotExist)
	f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, false, err
	}
	return osFile{f}, created, nil
}

func (osFS) Truncate(name string, size int64) error { return os.Truncate(name, size) }

func (osFS) SyncPath(name string) error {
	f, err := os.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (osFS) SyncDir(dir string) {
	if d, err := os.Open(filepath.Clean(dir)); err == nil {
		d.Sync()
		d.Close()
	}
}

type osFile struct{ *os.File }

func (f osFile) Size() (int64, error) {
	st, err := f.File.Stat()
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}
