# Security review follow-up, October 2026

Two review passes raised eleven findings. This records what was changed, what proves it, and what **cannot** be settled in code.
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
| F-06 | Concurrent approvals could execute twice | **Fixed** |
| F-07 | Log persistence not crash-consistent | **Fixed** (on this filesystem); power-loss test **open** |
| F-08 | Public log API resource limits | **Fixed** (basic limits); load test **open** |
| F-09 | Payment idempotency and reconciliation | **Partly** |

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
| **F-06 on real Postgres** | The race test ran on embedded Postgres (single connection, serialised). The row lock is standard Postgres but was not exercised with concurrent connections. | Run `test/hardening.test.ts` against `DATABASE_URL` (the suite still defaults to embedded). |
| **F-07 power loss** | fsync is called; whether the disk, Docker volume or hypervisor honours it was not tested. No kill-during-write harness exists. | Test on the target host with forced power-off or a fault-injecting filesystem. |
| **F-08 load** | Limits are unit tested; behaviour under real traffic and a reverse proxy (where the limiter sees the proxy's address) was not. | Load test through the real proxy; add limits at the proxy too. |

## Smaller things noticed

- A log event is appended after the database write (members, finance). A crash between the two leaves a database row with no
  public event. Not fixed; it needs an outbox pattern. For payments, the retry adopts the existing ledger row and does not re-emit it.
- The join confirmation (`ctx.pending`) is an in-process map, so USSD works with one platform instance only.
- Rate limiters are in memory per process; restarting resets them and several instances do not share counts.
- A successful PIN check resets the failure counter to zero, so an attacker timing guesses around a legitimate login could gain a few extra attempts.
- Pepper rotation has no tool (`docs/key-management.md`).

## Verification

See the Session 11 entry in `SESSION_CONTEXT.md` for the test counts at the time of writing.
