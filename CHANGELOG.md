# Changelog

All notable changes. This project uses [semantic versioning](https://semver.org/) once it reaches 1.0.

## 0.2.0 (unreleased)

### Security
- The public-log guard is now an allowlist: listed event types, exact fields, strict value shapes (`logschema.ts`). Serialized
  personal data inside a string field, unlisted field names and unknown event types are refused. 8 adversarial tests added.
- `docker-compose.yml` publishes the log, platform and portal ports on `127.0.0.1` only.
- **USSD webhook authenticated** (`USSD_WEBHOOK_SECRET`, optional `USSD_ALLOWED_IPS`), payload-validated and rate limited; the
  platform refuses to start without the secret unless `LAB_ENABLED=1`. The browser simulator uses a separate `/ussd/sim` that only
  exists in lab mode. PIN attempts are now counted atomically.
- **Approvals execute once** under concurrency (row lock plus an atomic pending to executing claim).
- **Trust log durability:** fsync before acknowledging, torn final record recovered, earlier damage refused; an oversized record is
  now refused with 413 instead of being silently truncated.
- **Trust log limits:** paged `/entries` (1000 entries / 4 MiB, `next` cursor), bounded proof work, per-address rate limit, HTTP
  timeouts, cached cosignatures. The witness pages through entries.
- **Payments:** idempotency keys, a `payment_attempts` table, reconciliation of unrecorded/unconfirmed/refund-due payments and a
  retry route. `Payments.charge` takes an idempotency key (adapters must honour it).
- **Key lifecycle:** master key ring with ids (`MASTER_KEYS`), `KeyProvider` interface, `npm run rotate-keys`, production guard for
  software keys, `docs/key-management.md`. Existing data keeps opening (the single key is `k0`).
- README states plainly that this is not an electronic voting system.

### Findings F-10 to F-14
- **Approvals** apply their effect, result, `executed` mark and public event in ONE transaction; claims have a token and a lease; `recoverApprovals` finishes the ones whose executor died. Test-only `ctx.crashAt` fault hook; 10 crash tests and a live kill test.
- **Durable security counters:** failed gateway authentication moved to a LOGGED table; volume counters stay UNLOGGED by decision.
- **PIN policy:** durable attempt log, rolling 24 h window (5) and 30-day hard lock (10), successes never erase failures; new ward-agent **PIN unlock** (`POST /agent/unlock-pin`, `member.pin_unlocked` event) because a lock was previously permanent.
- **Payments:** a retry now repairs a missing public event; `verify:consistency` checks every ledger row against its event.
- **Keys:** asynchronous `KeyProvider`; **Vault Transit provider**; lookup **pepper ring** with `npm run rotate-pepper` and a fixed reference pepper; `npm run replay-erasures` for restores; `scripts/backup-drill.mjs`; rewritten `docs/key-management.md`.
- Compose: `vault` profile (development Vault), `APPROVAL_LEASE_SECONDS`, Vault and pepper settings.

### Resilience
- **Transactional outbox:** every change and its public-log event commit in one database transaction; a publisher delivers them in
  order; the log ignores a repeated event key. A crash between the database write and the log append can no longer lose an event.
  `npm run verify:consistency` and `/healthz` backlog reporting added.
- **Shared rate limits** (PostgreSQL) and **join confirmation in the database** (encrypted): limits survive restarts and hold across
  instances. Per-address limit now counts only failed authentications; the gateway is throttled per phone number.
- Donor cap check now runs in the same transaction as the gift insert, serialised per donor.
- Trust log: storage seam with a power-loss simulator, SIGKILL test, `trustlog verify` and `trustlog repair`, persisted rate-limit
  state, idempotent append (`AppendOnce`, HTTP 200 for a repeat).
- PIN hashing is asynchronous (throughput about doubled under load); `restart: unless-stopped` on all services; idle database
  connection errors no longer crash the platform; fixed `BIGINT`-as-string bug found by running the suite on real PostgreSQL.
- Tools: `scripts/loadtest.mjs`, `scripts/chaos.mjs`, `scripts/test-postgres.mjs`, `scripts/powerloss-client.mjs`; docs
  `docs/load-test.md`, `docs/power-loss-test.md`.

### Added
- **Three layers on an international floor.** Floor v1.0 (F1 to F12), a country law pack format with citations, and party settings
  checked against the pack ("a party can tighten the law, never loosen it").
- Nigeria law pack **NG v1.0 (draft)**, 26 rules, and the Digital Democratic Party of Nigeria (DDPN) reference settings.
- Synthetic **Testland** pack (test fixture) proving the core has no country hard-coded.
- Configuration fingerprint (floor + pack + party) recorded and posted to the public log.
- `/framework` and `/framework/check` endpoints and a **Framework** page in the portal.
- Generic **ID adapter** interface with a public conformance suite; the Nigeria NIN check is now the `ng_nin` adapter.
- Public registry of deployments (`registry/deployments.json`) with a JSON Schema.
- Translation files (`locales/en.json`); user text is no longer in the code.
- OpenTimestamps anchoring (off by default), Rules lab, Test results page, test report script.
- Apache-2.0 licence, contributing guide, code of conduct, security policy, governance notes, CI workflow.

### Changed
- Legal numbers (notice, register and type-lock days, donor ceiling, accepted currency, register fields, allowed primary types and modes)
  are read from the law pack instead of being written into the code.
- Donor cap supports a rolling window (DDPN: one year).
- Nigeria-specific internals generalised: `amount_kobo` is `amount_minor`, `nin_hash` is `id_hash`, rule keys are namespaced.
  The database migrates in place, idempotently.

### Known gaps
- The Nigeria pack has not been reviewed by counsel and is unsigned.
- Voting, tally, ratings, tribunal, ombudsman and election-day modules are not built (P1/P2).
- Only English text is shipped; other languages need native speakers.
- No independent audit, red team or protocol proof.

## 0.1.0

- P0 pilot core: membership, register and notice gates, rules lock, dues and donor rules, witnessed public log, separation of powers,
  petitions, USSD join and dues.
