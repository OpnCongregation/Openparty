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
