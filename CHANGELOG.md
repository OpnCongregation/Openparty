# Changelog

All notable changes. This project uses [semantic versioning](https://semver.org/) once it reaches 1.0.

## 0.2.0 (unreleased)

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
