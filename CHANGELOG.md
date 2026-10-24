# Changelog

All notable changes. This project uses [semantic versioning](https://semver.org/) once it reaches 1.0.

## 0.2.0 (unreleased)

### Dependency security (GitHub reported 114 alerts)
- `npm audit`: **24 vulnerable packages to 0.** Same-major bumps: fastify 5.2.1 to 5.12.7 (content-type validation bypass, spoofable host and protocol headers, memory DoS), yaml 2.6.1 to 2.9.1,
  tsx 4.19.2 to 4.23.15, vitest 2.1.8 to 4.1.12 (dev only; remote-code-execution when its UI server runs), next 14.2.21 to 15.5.28 (the portal; works with React 18).
- Root `overrides` for packages pulled in by Semaphore, which has no newer release: `ws` 8.22.0, `ethers` 6.17.0, `circom_tester` 0.0.24 (removes an old snarkjs with the "double spend" advisory), `postcss` 8.5.31.
  Revisit these when `@semaphore-protocol/*` releases newer than 4.14.5.
- Python service: requirements pinned to exact versions; pydantic 1.9.0 to 1.10.21 (a regular-expression DoS in email validation, which we never use); `pip-audit` clean. The Go service has no third-party packages.
- Added `.github/dependabot.yml` (weekly, one pull request per advisory).

### Anonymous membership proof (Semaphore)
- Each member has one identity; the commitments of everyone on the frozen register form a fixed, sorted, public group, built when the election is sealed (the register must be frozen first).
  A ballot carries a zero-knowledge proof of membership with a nullifier (same person, same contest: same nullifier, so a re-vote replaces the earlier ballot; unlinkable across contests), bound to the ballot id and the contest, stored and published.
- **Device voters** make their identity in the browser (`/election/vote`), register only the commitment (PIN, before sealing) and then cast with **no login** (`POST /election/cast`). **Assisted voters** (USSD, terminal, web with a PIN) get a platform-derived identity and the same proofs.
- The public check now verifies every ballot's membership proof and that no two counted ballots share a nullifier. New: `semaphore.ts`, tables `identity_commitments`/`semaphore_groups`, `enc_ballots.proof`, event `group.built`, agent identity reset, the proving files served by the platform and pinned by SHA-256 (`scripts/fetch-semaphore-artifacts.mjs`, baked into the Docker image), `SEMAPHORE_DEPTH` (default 20).
- 15 new tests with REAL proofs; the whole flow also runs in Chrome (a voter makes an identity and casts anonymously). Packages `@semaphore-protocol/*` 4.14.5 pinned.

### Secret ballot (ElectionGuard) and guardians
- New `services/electionguard` (Python 3.10, ElectionGuard reference library 1.4.0; internal only; no state, no guardian secrets): election description, key combination, encryption, encrypted tally, opening the total from any quorum's shares,
  independent re-check. `guardian_tool` for the guardians' own device. 11 tests incl. opening the tally with 2 of 5 guardians absent, a dropped ballot and a tampered ballot.
- Platform `secret-ballot.ts`: **five guardians from the electoral committee** (appointed by the secretary, approved by the auditor and the tribunal, matching the contest's jurisdiction), distributed key ceremony (public messages only),
  `election.seal` (approved), encrypted casting with **no member id** (anonymous nullifier, day only, supersede on re-vote, separate turnout record), encrypted tally, shares from any 3 guardians, public record and ballots, independent verify,
  paper counts and the paper-versus-electronic audit. With `EG_URL` set, voting cannot open on an unsealed election.
- Screens: Guardians (their own steps and commands), Audit (record, independent check, paper audit and the agent's paper-count form), and the new desk steps (appoint, ceremony, seal, count). Demo shortcuts for the guardians (`EG_DEMO_GUARDIANS`).
- Tribunal gains `approval.approve` (an independent check). Form-fee cap hook removed (owner: no cap). Docs: `docs/guardians.md`, `docs/pending-tasks.md`.
- The ElectionGuard library logs raw cryptographic values at INFO: the service and the guardian tool switch logging off before importing it.

### Voting, phase 1: the ballot box (not a secret ballot; see docs/voting.md)
- Offices (races) set by the secretary or electoral committee; **anyone who registers to compete is a candidate**, public by design (consent, name on the log, erasure blocked);
  every admin can only give a **vetting stamp** (vetted or flagged), which never removes a candidate; optional **form fee** per office, paid once and listed in one transaction with the ledger row.
- Ballots by **USSD (menu 5), online and ward agent**: one per member per office, re-voting replaces it, abstain allowed, only members on the frozen, still-active register, only while open.
  Results hidden until close and published with turnout in the same transaction as the close. `contest.close` is now an approved action.
- Portal screens under `/election`: candidates and results, stand for office, vote online, polling-unit terminal, admin desk (step-by-step checklist, demo mode). Admin and agent requests are signed in the browser (Ed25519).
- **Demo mode** (`DEMO_MODE=1`, plus `ALLOW_DEMO_IN_PRODUCTION=1` under the compose stack): seeds fake admins and members, moves the clock. Off by default, refused in production.
- **Fixed (pre-existing):** the admin access log recorded concrete URLs; an approval id (UUID) with a long run of digits was refused by the public-log guard, failing the approve request with a 500 at random. It now logs the route pattern.
- CORS preflight for JSON posts and signed admin requests; `/public/time` so browsers sign with the platform's clock.
- New docs: `docs/voting.md`, `docs/secret-ballot-recommendation.md`.

### Security
- **Election gates (sample-election probe):** voting can open or close only on or after the vote date (`too_early`); closing is now an approved action
  (`contest.close`, proposed by the electoral committee, approved by secretary and auditor) instead of a bare function; INEC receipt references must be
  6-64 characters of letters, digits and `. _ / -` (`bad_receipt`); two unclosed contests cannot share a vote date (`contest_overlap`); a failed register
  freeze lists every incomplete member record, not just the first; `isEligible()` defines who may vote (on the frozen register AND still active);
  the admin can now **file only the complete records**: `GET /admin/contests/:id/register-check` lists the incomplete members (card number and missing fields), a
  failed freeze returns the same list as structured `details`, and a `register.freeze` approval with `excludeIncomplete: true` files the rest. Left-off members are kept in
  `register_exclusions` (they are not on the register, so `isEligible` is false), and the public log's `register.frozen` carries only `excluded_count`.
  **Appeal period (no screen):** members with an incomplete record get SMS notices naming what is missing and, when a contest is coming, the register
  filing date (weekly, then 3 days and 1 day before; undated and once when no contest is scheduled; failed SMS retried). They can complete the record at any time:
  USSD option 4 for address, state, LGA, polling unit and disability status, or a ward agent (`POST /agent/complete-record`) for the rest; only EMPTY fields can be filled,
  nothing on file is overwritten. Filing without incomplete members (`excludeIncomplete`) is refused (`appeal_open`) until each was notified and 7 days have passed, except
  inside the last day before the deadline; left-off members get a one-time SMS and a `member.record_completed` event (no values) marks completion. 11 tests.
  Reopening a closed contest says `already_closed`. 6 tests in `election-gates.test.ts`.
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
