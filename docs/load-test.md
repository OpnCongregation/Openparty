# Load and crash testing

Tools, how to run them, and what they showed on the development stack. **These numbers come from one Windows laptop running
Docker Desktop (8 virtual CPUs, ARM), the load generator on the same machine, simulated NIN checks, SMS and payments.** They show
where the bottlenecks are and that the system stays correct under stress. They are not a capacity promise for any real deployment.

## Tools

| Tool | What it does |
|---|---|
| `node scripts/loadtest.mjs --secret <USSD_WEBHOOK_SECRET> --scenario ussd\|log\|mixed --steps 5,20,60 --step-seconds 12` | Ramps concurrent users through full USSD journeys (join, then pay dues) and/or log reads and proofs. Prints p50/p95/p99, throughput, status codes, journeys completed, outbox backlog. Takes `--platform` and `--log` URLs, so it can be pointed at a real deployment. Writes `reports/loadtest-latest.json`. |
| `node scripts/chaos.mjs --secret <...> --seconds 60 --users 6 --kills 8` | Drives the same traffic while `docker kill -s KILL`-ing the platform, the trust log and the database at random, then checks that nothing was lost or duplicated and that the database and public log agree. Process crashes only; see [power-loss-test.md](power-loss-test.md) for power cuts. |
| `npm run verify:consistency` (in `services/platform`) | Compares the database's outbox with every entry in the public log. Run it after any incident, and periodically. |
| `node scripts/test-postgres.mjs` | Runs the whole platform test suite against a throwaway real PostgreSQL 16 in Docker (the default run uses an embedded one). |

Run them only against a test environment: they create members and payments.

## Results on the development stack

### USSD journeys (join + dues), 12 s per step

| | 60 concurrent users |
|---|---|
| **Before** (PIN hashing blocked the process) | 9.8 journeys/s; "confirm join" p50 4.1 s, p95 5.4 s; even a plain menu step had p99 0.9 s |
| **After** (PIN hashing on the thread pool) | 17-19 journeys/s; "confirm join" p50 1.6 s, p95 2.0 s; menu step p99 0.3 s |

**Finding and fix.** PIN hashing (`scrypt`) was called synchronously, so each join and each PIN check froze every other request for
tens of milliseconds. It now runs asynchronously (`src/crypto.ts`). Throughput roughly doubled and unrelated requests stopped
queueing behind it. Raising the thread pool (`UV_THREADPOOL_SIZE`, now 8 in `docker-compose.yml`) made no measurable difference
here: the platform was using about 2.8 CPU cores, all of it hashing. **PIN hashing is now the capacity limit: about 75 ms of CPU per
join and per PIN check on this hardware.** Capacity grows with cores; it can also be raised by lowering the scrypt cost (the stored
hash would need a version marker, and the cost buys little against a 4-digit PIN whose real protection is the 5-attempt limit) or
by keying the hash with a secret from the key store, so a database leak alone is not enough to try all 10,000 PINs. Neither is done.

### Public log reads, 10 s per step, one client address

- With the default limit (600 requests per minute per address, burst 120) the log answered about 120 requests and returned 429 for
  the rest: the limiter works, and it also means **many legitimate users behind one NAT or proxy share one allowance**. Put a caching
  proxy or CDN in front of `/head` and `/entries` (they are cacheable for a second or two) and limit at the proxy.
- With the limit lifted to measure the server: about 1,000-1,400 requests per second in total across `/head`, `/entries`, inclusion
  and consistency proofs, p99 under 30 ms at 10 users and about 100 ms at 50 users. At 50 users roughly a quarter of proof requests
  were refused with 503 by design (at most 8 proofs run at once). Callers should retry after the `Retry-After` header.

### Crash test (`scripts/chaos.mjs`), 60 s, 6 users, 6 SIGKILLs (platform x3, database x2, trust log x1)

3,473 requests; 258 transport errors and 123 refusals while services were down (expected). 347 joins and 334 dues payments were
acknowledged to users. After everything restarted: the outbox drained; every acknowledged join and payment was in the database;
**the database held exactly 347 new members and 334 dues rows, and the public log exactly 347 `member.joined` and 334 `finance.dues`
events**; `verify:consistency` found 0 problems across 3,590 published events. This is one run: it shows the design holds, not that
every timing is covered.

### Consistency after load

After about 1,160 load-test operations the checker matched 2,909 outbox events to 2,909 log entries (8 older entries predate the
outbox and have no key).

## What this does not show

- Behaviour on production hardware, a real network, a real reverse proxy, a real USSD gateway or a real payment provider.
- Several platform instances at once (the shared limiter, pending joins and outbox are designed for it and tested for correctness,
  but the load test ran one).
- Sustained load over hours, memory growth, database growth and vacuum behaviour, backup impact.
- A power cut ([power-loss-test.md](power-loss-test.md)).

To get numbers that mean something, run `loadtest.mjs` from a separate machine against the real deployment through its real proxy,
with the real gateway's expected peak, and keep the chaos test for staging.
