package main

import (
	"bufio"
	"bytes"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestHelperAppender is not a test: it is the child process that TestKillDuringAppends starts and kills. It appends
// entries as fast as it can and prints each index after the log acknowledged it.
func TestHelperAppender(t *testing.T) {
	path := os.Getenv("OPENPARTY_CRASH_LOG")
	if path == "" {
		t.Skip("helper process only")
	}
	l, err := OpenLog(path, testKey())
	if err != nil {
		fmt.Println("OPENFAIL", err)
		os.Exit(3)
	}
	for i := l.Size(); ; i++ {
		idx, err := l.Append(payload(i))
		if err != nil {
			fmt.Println("APPENDFAIL", err)
			os.Exit(4)
		}
		fmt.Println("ACK", idx)
	}
}

// TestKillDuringAppends kills a real appending process at random moments and reopens its log. It proves the log survives
// the PROCESS dying at any point of an append (including a half-written line). It does not prove survival of a power cut:
// after a process kill the operating system still holds unsynced data. See TestPowerLoss* for the sync ordering, and
// docs/power-loss-test.md for the real thing.
func TestKillDuringAppends(t *testing.T) {
	if testing.Short() {
		t.Skip("kill test skipped in -short")
	}
	path := filepath.Join(t.TempDir(), "log.jsonl")
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	highestAcked := -1
	torn := 0

	for round := 0; round < 30; round++ {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperAppender$", "-test.v")
		cmd.Env = append(os.Environ(), "OPENPARTY_CRASH_LOG="+path)
		out, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		acks := make(chan int, 1<<16)
		failed := make(chan string, 1)
		go func() {
			sc := bufio.NewScanner(out)
			for sc.Scan() {
				f := strings.Fields(sc.Text())
				if len(f) == 2 && f[0] == "ACK" {
					n, _ := strconv.Atoi(f[1])
					acks <- n
				} else if len(f) >= 1 && (f[0] == "OPENFAIL" || f[0] == "APPENDFAIL") {
					select {
					case failed <- sc.Text():
					default:
					}
				}
			}
			close(acks)
		}()
		time.Sleep(time.Duration(30+rng.Intn(150)) * time.Millisecond)
		cmd.Process.Kill()
		cmd.Wait()
		for n := range acks {
			if n > highestAcked {
				highestAcked = n
			}
		}
		select {
		case msg := <-failed:
			t.Fatalf("round %d: child reported %s", round, msg)
		default:
		}

		l, err := OpenLog(path, testKey())
		if err != nil {
			t.Fatalf("round %d: log did not reopen after a kill: %v", round, err)
		}
		if l.Recovered > 0 {
			torn++
		}
		if l.Size() < highestAcked+1 {
			t.Fatalf("round %d: entry %d was acknowledged but the log holds %d entries", round, highestAcked, l.Size())
		}
		for i := 0; i < l.Size(); i++ {
			if !bytes.Equal(l.entries[i], payload(i)) {
				t.Fatalf("round %d: entry %d is not what was appended", round, i)
			}
		}
	}
	t.Logf("30 kills, %d entries acknowledged, %d restarts had a torn final record to drop", highestAcked+1, torn)

	// The whole history is still one consistent log.
	final, _ := OpenLog(path, testKey())
	clean, _ := OpenLog("", testKey())
	for i := 0; i < final.Size(); i++ {
		clean.Append(payload(i))
	}
	a, _ := final.RootAt(final.Size())
	b, _ := clean.RootAt(clean.Size())
	if !bytes.Equal(a, b) {
		t.Fatal("root after 30 kills differs from a clean rebuild")
	}
}
