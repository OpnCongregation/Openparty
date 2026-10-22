# Security review follow-up, October 2026

Two review passes raised eleven findings, and a third pass (section "Follow-up") three more. This records what was changed, what proves it, and what **cannot** be settled in code.
It is a self-assessment by the project, not an audit. No independent party has reviewed this code.

Status key: **Fixed** = changed and covered by tests. **Partly** = the code part is done, the rest needs a person or a service.
**Open** = deliberately not fixed here; the reason and the owner action are given.

| # | Finding | Status |
|---|---|---|
| P1-a | Public-log privacy guard bypassed by data shape | **Fixed** |
| P1-b | Compose published ports on all interfaces | **Fixed** (config); real exposure **needs a scan** |
| F-01 | USSD webhook accepts a caller-supplied identity | **Partly** |
| F-02 | Public-log privacy filter incomplete | **Fixed** (same change as P1-a) |
| F-03 | Key lifecycle and recovery | **Partly** |
| F-04 | Service ports without a network boundary | **Fixed** (config); needs a scan on the real host |
| F-05 | No end-to-end voting guarantees | **Open** (unbuilt by design) |
| F-06 | Concurrent approvals could execute twice | **Fixed**; race test passes on real PostgreSQL |
| F-07 | Log persistence not crash-consistent | **Fixed**; simulated power loss and process-kill tests pass; a real power cut is **owner-run** |
| F-08 | Public log API resource limits | **Fixed**; measured on the dev stack; load test on the real deployment is **owner-run** |
| F-09 | Payment idempotency and reconciliation | **Partly** |
| C-1 | A crash between the database write and the log append leaves an event missing | **Fixed** (transactional outbox) |
| C-2 | Rate limits are per process: reset on restart, not shared across instances | **Fixed** (platform: shared through PostgreSQL; log: persisted, single instance by design) |
| C-3 | Power-loss recovery and real-deployment load untested | **Partly**: tools, simulations and local measurements done; real power cut and real-deployment load are **owner-run** |

## What was fixed

**Public log (P1-a, F-02).** `services/platform/src/logschema.ts` is an allowlist: 24 event types, the exact fields of each, and a
strict shape per field (UUID, 64-hex hash, 24-hex pseudonymous reference, UTC time, lowercase token, short plain label). Free text,
nested objects, serialized JSON, unknown event types and unlisted field names are refused; text fields also refuse runs of seven or
more digits. Both log implementations enforce it, and the old key denylist remains as a second check. Tests: `test/logschema.test.ts`.

**Ports (P1-b, F-04).** Log, platform and portal bind to `127.0.0.1` in `docker-compose.yml`. The README says to serve others through a
TLS reverse proxy and never to expose admin routes, the append endpoint or the lab.

**USSD webhook (F-01).** `src/ussd-guard.ts`. `POST /ussd` exists only when `USSD_WEBHOOK_SECRET` is set; it is compared in constant
time (header `x-ussd-secret` or Basic password); `USSD_ALLOWED_IPS` optionally restricts source addresses; phone, text and session id
are validated; requests are rate limited per address (also throttling secret guessing) and per phone. The platform refuses to start
without the secret unless `LAB_ENABLED=1`. The browser simulator moved to `/ussd/sim`, which exists only in lab mode. PIN attempts are
counted with an atomic update before the comparison, so parallel guesses cannot beat the 5-attempt limit.
Tests: 8 in `test/hardening.test.ts`. Live: no secret 401, wrong secret 401, bad phone 400, 40 rapid calls from one phone gave 30 x 200 and 10 x 429.

**Approvals (F-06).** `admin.approve` takes a row lock, records the vote and counts in one transaction, and only the request that wins
an atomic `pending -> executing` update runs the action. Test: six approvers racing run the action once, with one `approval.executed`
log event. Verified on embedded Postgres only (see Open).

**Log durability (F-07).** `Append` fsyncs before returning and cuts the file back on failure; `OpenLog` drops a torn final record
(unterminated or undecodable last line) with a log message, and refuses damage earlier in the file. Separately, a record over the 1 MiB
cap used to be silently truncated and then logged; it is now refused with 413. Go tests cover each torn-tail shape, mid-file damage
(file left untouched), a failed append, and root equality after recovery.

**Log API limits (F-08).** `/entries` is paged (1000 entries or about 4 MiB, with a `next` cursor) and rejects bad ranges; proofs run in
8 slots (503 beyond); a per-address token bucket (default 600/min, burst 120; the authenticated append is exempt); HTTP server
timeouts; cosignatures cached for a second so many readers do not each trigger outbound calls to every witness; the witness pages
through entries. Live: 800 rapid requests gave 204 x 200 and 596 x 429, cosignatures stayed at 2.

**Payments (F-09).** `payment_attempts` is written before the provider is called, keyed by a keyed hash of gateway session, phone and
request text (the PIN is never stored). The provider gets the same idempotency key on retries. States `charging` (outcome unknown),
`charged` (confirmed, not yet in the ledger), `recorded`, `refund_due` (taken, then refused by a rule such as foreign funds). `reconcile`
reports anything unsettled; `POST /admin/finance/retry-payments` (treasurer) finishes `charged` rows; checks that can run before
charging (membership, minimum dues) now run first so no money moves for a refusal we could predict. Live: the same USSD session sent
twice produced one ledger row.

**Keys (F-03, code part).** Master key ring with ids (`MASTER_KEYS`, `MASTER_KEY_ACTIVE`), a `KeyProvider` interface so an HSM/KMS can
replace the software provider, `npm run rotate-keys`, and a production guard (`NODE_ENV=production` refuses software keys unless
`ALLOW_SOFTWARE_KEYS=1`). `docs/key-management.md` has rotation, destruction, recovery and the limits. Live: the demo database was
rotated on real Postgres (3 data keys from `k0` to `k1`) and all three member records still decrypted afterwards.

## What cannot be fixed in code (open items and owner actions)

| Item | Why it stays open | Owner action |
|---|---|---|
| **F-05 voting** | No voting, ballot secrecy, one-member-one-vote at the ballot, tally, or coercion resistance exists. A signed log shows events were not altered; it proves none of those. | Treat each as its own requirement with a threat model and independent review before any real use (PRD P1/P2). The README now says this is not an electronic voting system. |
| **F-03 HSM** | Master keys are in process memory and `.env`. Only an HSM/KMS makes them non-exportable. | Choose a provider and write its `KeyProvider`. Until then keep `ALLOW_SOFTWARE_KEYS` as an explicit, recorded decision. |
| **F-03 backups and replicas** | Erasure deletes the live row. Backups, replicas, WAL and dead tuples keep copies, and a restored copy reopens the record (this is a test). | Set a backup retention period, rotate the master key within it, destroy old keys after the last dependent backup expires, rehearse a restore, and re-apply `member.erased` events after any restore. Not automated. |
| **F-04 / P1-b real exposure** | Nothing is deployed publicly; the compose file proves intent, not reachability. | Put a TLS reverse proxy and firewall in front, then scan the real host from outside. |
| **F-01 gateway authentication** | Africa's Talking-style gateways do not sign requests; a shared secret and source IP allowlist is what is available, and the real IPs are unknown. | Confirm with the chosen gateway what authentication and source addresses it offers; set `USSD_ALLOWED_IPS`; keep the secret out of URLs that are logged. |
| **F-01 phone number as identity** | A phone number from the carrier is still only a claim (SIM swap, spoofed MSISDN at a bad gateway). The PIN and attempt limit are the control. | Decide whether dues or card lookups need a stronger factor for SIM-swap risk; monitor `pin_locked` events. |
| **F-09 real provider** | The payment adapter is simulated. Real idempotency, timeouts, webhooks and refunds depend on the provider. | A real adapter must honour `idempotencyKey` (documented on the interface), pass the conformance behaviour in `FlakyPayments` tests, and refunds for `refund_due` need a process. |
| **F-07 / C-3 real power cut** | The log's write and sync ORDER is tested against a disk that forgets unsynced data, and the process is killed at random points. Whether a real disk, Docker volume or hypervisor honours `fsync` can only be found by cutting power. | Run the procedure in [power-loss-test.md](power-loss-test.md) on the deployment hardware, at least ten cycles. |
| **F-08 / C-3 real load** | Measured on one laptop with the generator on the same machine ([load-test.md](load-test.md)). Behaviour with a real proxy (where per-address limits see the proxy), real gateway peaks and sustained hours is unknown. | Run `scripts/loadtest.mjs` from another machine through the real proxy; limit at the proxy too; put a cache in front of the public log reads. |
| **PIN hashing capacity** | PIN hashing is now the platform's capacity limit (about 75 ms CPU per join and PIN check on the test machine). | Size cores for expected peak, or version the hash format to lower its cost / key it with a secret from the key store (not done). |

## Follow-up: consistency, shared limits, resilience

**C-1 Database and public log (transactional outbox).** Every domain change used to write the database and then call the log in a
separate step; a crash between them lost the event, and (in one place) a rollback could leave an event with no row. Now each change
queues its event in the `log_outbox` table **inside the same database transaction** (`ctx.commit` + `ctx.events.emit`, 24 call
sites in `members`, `finance`, `contests`, `participation`, `admin`, `deploy`). A publisher copies committed events to the log in
order (advisory lock, so one publisher at a time even across instances), right after commit and again from a background loop
that heals a crash. Each event carries a random key (`oid`); the log ignores a repeated key, so publishing twice is harmless
(`AppendOnce`, kept across restarts). An event that could never pass the public-log allowlist now fails the transaction instead of
waiting forever. `npm run verify:consistency` compares the database with every log entry. `/healthz` reports the backlog and turns
"degraded" if an event waits over a minute. Also fixed on the way: a donor cap check that two simultaneous gifts could both pass
(now serialised per donor inside the same transaction as the insert). Evidence: 22 tests in `test/resilience.test.ts`, 8 Go tests for the key, the crash run in
[load-test.md](load-test.md) (347 joins and 334 payments: database and log agree exactly), and 2,909 events matched on the demo stack.
Residual: an approval whose action committed but whose "executed" mark did not is left in `executing`; the checker reports it, nothing repairs it.

**C-2 Shared rate limits.** Platform limits (per phone, failed authentication, simulator, gateway ceiling) count in PostgreSQL
(`UNLOGGED rate_limits`, blended sliding window) behind a local in-memory layer, so they hold across restarts and several instances.
Also changed: the per-address limit no longer caps the whole gateway (all real traffic arrives from the aggregator''s few addresses): it
counts only FAILED authentications; the real per-user throttle is per phone number. Join confirmation moved from an in-process map
to an encrypted `pending_joins` table, which removes the other single-instance restriction. The trust log is single-writer by
design (one process per data directory), so there is nothing to coordinate; its limiter state is now saved every 10 s and on SIGTERM
and reloaded at start. Not done: a shared store faster than PostgreSQL (Redis) was considered and not chosen; each USSD request costs
one extra small write. A crash of the database itself resets the counters (UNLOGGED table).

**C-3 Power loss and load.** Added: a storage seam in the log with a disk simulator that loses unsynced data (400 random trials,
four crash shapes), a SIGKILL harness (30 kills), `trustlog verify` and `trustlog repair`, a power-cut client and procedure, a chaos test for the Docker stack, a load tester, and the platform suite on real
PostgreSQL (157 tests pass; this also found a real bug: `BIGINT` columns are strings on a real server, fixed). The load test found
that PIN hashing blocked the whole process (now asynchronous; throughput roughly doubled). A crash test also showed the platform exiting when
a database connection died while idle (now logged and reconnected), and the compose file now restarts services (`restart: unless-stopped`).
## Smaller things noticed

- If a payment was recorded by an earlier run that died before updating its attempt, the retry adopts the existing ledger row and does not re-emit its event (rare; it predates the outbox).
- The witnesses run on the same host as the log in the demo stack; real witnesses are independent parties.
- A successful PIN check resets the failure counter to zero, so an attacker timing guesses around a legitimate login could gain a few extra attempts.
- Pepper rotation has no tool (`docs/key-management.md`).

## Verification

See the Session 11 entry in `SESSION_CONTEXT.md` for the test counts at the time of writing.
