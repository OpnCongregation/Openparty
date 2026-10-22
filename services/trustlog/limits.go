package main

import (
	"net"
	"net/http"
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
