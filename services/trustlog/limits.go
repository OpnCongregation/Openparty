package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Limits on what one caller can make the public API do. The log's read endpoints are meant to be public, so they must
// stay cheap for the server whatever is asked of them.
const (
	maxEntriesPerPage  = 1000    // entries returned by one /entries call
	maxEntriesBytes    = 4 << 20 // decoded bytes returned by one /entries call (at least one entry is always returned)
	maxAppendBytes     = 1 << 20 // largest accepted record
	maxConcurrentProof = 8       // proof computations running at once; more get 503
)

// ipLimiter is a token bucket per client address.
type ipLimiter struct {
	mu      sync.Mutex
	rate    float64 // tokens per second
	burst   float64
	buckets map[string]*bucket
	now     func() time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newIPLimiter(perMinute, burst int) *ipLimiter {
	return &ipLimiter{rate: float64(perMinute) / 60, burst: float64(burst), buckets: map[string]*bucket{}, now: time.Now}
}

func (l *ipLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) > 50_000 { // a flood of distinct addresses: forget everyone rather than grow without bound
			l.buckets = map[string]*bucket{}
		}
		b = &bucket{tokens: l.burst, last: t}
		l.buckets[key] = b
	}
	b.tokens += t.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = t
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// limit wraps a handler. The authenticated append endpoint is exempt: its caller is the platform, it has a token and a
// body cap, and throttling it would turn a burst of legitimate events into lost ones.
func (l *ipLimiter) limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/append" {
			next.ServeHTTP(w, r)
			return
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if !l.allow(host) {
			w.Header().Set("Retry-After", strconv.Itoa(int(1/l.rate)+1))
			writeJSON(w, 429, map[string]string{"error": "rate limited"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// newHTTPServer applies timeouts so slow or stalled clients cannot hold connections open indefinitely.
func newHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

// ---- Persistence ---------------------------------------------------------------------------------------------------
// The limiter state is written to disk so a restart does not hand every address a fresh allowance. This is one log
// process per data directory (the log has a single writer by design), so there is nothing to coordinate between
// instances; several log instances on one data directory are not supported.

type savedBucket struct {
	Tokens float64 `json:"t"`
	Last   int64   `json:"l"` // unix nanoseconds
}

// save writes the buckets that are not full (a full bucket is the same as no bucket). Atomic: temp file then rename.
func (l *ipLimiter) save(path string) error {
	l.mu.Lock()
	out := make(map[string]savedBucket, len(l.buckets))
	now := l.now()
	for k, b := range l.buckets {
		t := b.tokens + now.Sub(b.last).Seconds()*l.rate
		if t < l.burst {
			out[k] = savedBucket{Tokens: t, Last: now.UnixNano()}
		}
	}
	l.mu.Unlock()
	raw, err := json.Marshal(out)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// load restores saved buckets. A missing or unreadable file is not an error: the limiter just starts empty.
func (l *ipLimiter) load(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var in map[string]savedBucket
	if json.Unmarshal(raw, &in) != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, s := range in {
		l.buckets[k] = &bucket{tokens: s.Tokens, last: time.Unix(0, s.Last)}
	}
}

// persist loads the saved state, then saves it every interval and when the returned function is called (on shutdown).
func (l *ipLimiter) persist(dir string, every time.Duration) (flush func()) {
	path := filepath.Join(dir, "ratelimit.json")
	l.load(path)
	go func() {
		for range time.Tick(every) {
			l.save(path)
		}
	}()
	return func() { l.save(path) }
}
