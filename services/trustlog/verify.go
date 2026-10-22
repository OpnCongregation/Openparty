package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// runVerify inspects a log file WITHOUT changing it and checks that every entry a client was told was stored is there.
// Used after a real power cut: the client (on another machine) records each index the log acknowledged; after the host
// comes back, `trustlog verify -file log.jsonl -acked acked.txt` must say ok. Exit 0 = ok, 1 = problem.
//
//	trustlog verify -file DATA/log.jsonl [-acked acked.txt]
func runVerify(args []string) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	file := fs.String("file", "", "path to log.jsonl")
	acked := fs.String("acked", "", "file with one acknowledged entry index per line (highest wins)")
	if err := fs.Parse(args); err != nil || *file == "" {
		fmt.Fprintln(os.Stderr, "usage: trustlog verify -file log.jsonl [-acked acked.txt]")
		return 2
	}
	l, err := openLog(osFS{}, *file, ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize)), false)
	rep := map[string]any{"file": *file}
	fail := func(msg string) int {
		rep["ok"] = false
		rep["problem"] = msg
		b, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Println(string(b))
		return 1
	}
	if err != nil {
		return fail(err.Error())
	}
	root, _ := l.RootAt(l.Size())
	rep["entries"] = l.Size()
	rep["tornTailBytes"] = l.Recovered // would be dropped on the next start; never acknowledged
	rep["root"] = fmt.Sprintf("%x", root)
	if *acked != "" {
		raw, err := os.ReadFile(*acked)
		if err != nil {
			return fail("cannot read acked file: " + err.Error())
		}
		maxIdx := -1
		for _, ln := range strings.Fields(string(raw)) {
			if n, err := strconv.Atoi(ln); err == nil && n > maxIdx {
				maxIdx = n
			}
		}
		rep["highestAcknowledged"] = maxIdx
		if maxIdx >= l.Size() {
			return fail(fmt.Sprintf("LOST DATA: entry %d was acknowledged but the log holds only %d entries", maxIdx, l.Size()))
		}
	}
	rep["ok"] = true
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
	return 0
}

// runRepair cuts a log file back to its last readable record, for the case a crash left damage that is not a simple torn
// tail (for example stale blocks containing newlines after the last synced record). It never discards silently: the removed
// bytes are saved next to the file, and it refuses to run without -yes. A witness that cosigned a longer log will report
// the shrinkage, so repairing cannot hide lost acknowledged entries.
//
//	trustlog repair -file DATA/log.jsonl -yes
func runRepair(args []string) int {
	fs := flag.NewFlagSet("repair", flag.ContinueOnError)
	file := fs.String("file", "", "path to log.jsonl")
	yes := fs.Bool("yes", false, "really cut the file")
	if err := fs.Parse(args); err != nil || *file == "" {
		fmt.Fprintln(os.Stderr, "usage: trustlog repair -file log.jsonl -yes")
		return 2
	}
	raw, err := os.ReadFile(*file)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read:", err)
		return 1
	}
	// Cut at the first unreadable record, whatever follows it.
	good := 0
	for good < len(raw) {
		nl := bytes.IndexByte(raw[good:], '\n')
		if nl <= 0 {
			break
		}
		if _, _, e := scanRecords(raw[good : good+nl+1]); e != nil {
			break
		}
		if recs, _, _ := scanRecords(raw[good : good+nl+1]); len(recs) != 1 {
			break
		}
		good += nl + 1
	}
	removed := raw[good:]
	fmt.Printf("%s: %d readable bytes kept, %d bytes would be removed\n", *file, good, len(removed))
	if len(removed) == 0 {
		fmt.Println("nothing to repair")
		return 0
	}
	if !*yes {
		fmt.Println("run again with -yes to cut the file (the removed bytes are saved beside it)")
		return 1
	}
	saved := fmt.Sprintf("%s.removed-%s", *file, time.Now().UTC().Format("20060102T150405Z"))
	if err := os.WriteFile(saved, removed, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "cannot save removed bytes:", err)
		return 1
	}
	if err := os.Truncate(*file, int64(good)); err != nil {
		fmt.Fprintln(os.Stderr, "cannot truncate:", err)
		return 1
	}
	if err := (osFS{}).SyncPath(*file); err != nil {
		fmt.Fprintln(os.Stderr, "cannot sync:", err)
		return 1
	}
	fmt.Println("repaired; removed bytes saved to", saved)
	return 0
}
