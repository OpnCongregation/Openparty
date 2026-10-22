# Legal traceability: Nigeria law pack NG v1.0 (draft)

> **Draft. Not reviewed by counsel. Not legal advice.** This maps the legal clauses in the product requirements (section 4) to the
> machine-readable rules in [`packs/ng/v1/pack.yaml`](../packs/ng/v1/pack.yaml) and to the tests that prove them.
> The live, always-current view (which rules are enforced by code, which are only declared, which need a human) is the **Framework**
> page in the portal and `GET /framework` on the platform.
>
> Legal numbers are no longer written into the code. They come from the pack (for example `NG-NOT-01` sets the 21 days); the same code
> run on the synthetic Testland pack enforces different numbers (`test/layers.test.ts`).

| Pack rule | Clause | Pack rule | Clause |
|---|---|---|---|
| NG-ID-01 | s.77(2), Reg 4(1) | NG-PRI-04 | Reg 27(1) |
| NG-REG-01..03 | s.77(4)-(7), Reg 4 | NG-ELIG-01, 02 | s.85, s.88(1) |
| NG-CARD-01 | s.77(3) | NG-FIN-01..04 | s.94, Reg 39, s.89, Reg 42, s.90 |
| NG-NOT-01..03 | s.82, Reg 10, 22, 23 | NG-ORG-01..04 | Reg 1, 3, 16 |
| NG-PRI-01..03 | s.84, s.87, Reg 24 | NG-SAF-01, 02 | s.96(5),(6), s.101 |
| | | NG-DP-01 | NDPA 2023 s.30 |

Tests added with the layered design: `test/framework.test.ts` (pack loading, expressions, tighten-never-loosen, compliance honesty,
signed packs), `test/layers.test.ts` (Testland, run-time rule changes, DDPN yearly donor window, configuration fingerprint on the log,
database migration, `/framework`), `test/adapters.test.ts` (ID adapter conformance).

Status of each row for the P0 build. "Test" names the automated test in `services/platform/test/acceptance.test.ts`
unless noted. **Not built** means the PRD row belongs to a later module (P1/P2) and has no code yet.

| Source | Requirement | Status | Test |
|---|---|---|---|
| s.77(2), Reg 4(1) | Register holds the listed fields, encrypted | Done | "activation requires every register field…", "freeze exports exactly the required fields…", "validator flags a missing field" |
| s.77(3) | Card on registration; no active member without card | Done | "database refuses an active member without a card" |
| s.77(4)-(7), Reg 4(3)-(6) | Register frozen 21 days before; fingerprint on log; contest locked without INEC receipt | Done, except export is JSON, not read-only PDF | "register cannot be frozen inside 21 days", "contest cannot open without…receipt", "tampering with the stored register is detected" |
| s.82(1),(6), Reg 10(1), 22(1) | 21 days' notice; voting locked until receipt uploaded | Done | "notice is refused inside 21 days…", "contest cannot open without…" |
| Reg 10(2) | Notice states mode | Done | "a contest cannot exist without a mode" |
| Reg 22(3), 23(2) | Guidelines published 10 days before | **Not built** | |
| Reg 10(4) | Document pack at T-7 | **Not built** | |
| s.85, Reg 23(4), 25(1) | No party criteria beyond Constitution | Done for rules: no configurable key can add criteria. Eligibility engine itself is P1 | "has no rule that could add aspirant criteria" |
| Reg 23(3) | No exclusion by sex, religion, etc. | Nothing to enforce yet (no eligibility code); revisit with P1 | |
| Reg 25(2) | Aspirant fee limits | **Not built** | |
| s.84(2), s.87, Reg 24(5), 28(5) | Consensus consent rules | **Not built** (P1) | |
| Reg 24(3) | Primary type locked inside 3 days | Done | "cannot change type at T-3, can at T-4" |
| s.88(1) | Appointees excluded | **Not built** (P1) | |
| Reg 14(c) | INEC monitor console | **Not built**; the log verifier is the start of it | |
| Reg 27(1) | EC16B form | **Not built** (P1) | |
| Reg 27(2), 46, 47 | Tribunal, evidence bundle | **Not built** (P1) | |
| s.94(1),(2), Reg 39(1), 44 | No anonymous gifts; donor capture; cap; donor report | Done | "anonymous gift rejected", "per-donor cap is cumulative…", "ledger is immutable and report reconciles" |
| s.89, Reg 42 | Foreign funds refused and quarantined | Done | "foreign payment refused and quarantined" |
| s.90(1), Reg 41; s.93(3), Reg 43 | Annual statement; audited election expenses | **Partly**: donor report and reconciliation exist; annual member list and statements do not | |
| Reg 40(4) | Primary spending cap | **Not built** | |
| s.96(5),(6) | No security role | Done | "no security role and no super admin" |
| s.101 | Moderate religion/tribe campaigning | **Not built** (P1 ratings) | |
| Reg 1(3), 3, 16 | 24-state spread, 4-year terms | **Not built** | |
| NDPA 2023 s.30 | Consent, DPIA, DPO, licensed auditor | **Process, not code.** The sign-up screen states the INEC disclosure; consent capture and the DPIA still need doing | |
| Right to erasure | Crypto-shredding | Done; blocked while on a live register | "destroying the key makes the record unreadable…", "blocked while…live contest register" |

Cross-cutting checks: no personal data on the public log ("refuses personal keys", "a full join/activate/pay cycle puts no
identity strings on the log"); append-only ledger, rules and access log (database triggers); one NIN one member; PIN lockout;
signed, non-replayable admin requests; separation of powers ("register freeze needs two approvers…").

Go tests (`services/trustlog/log_test.go`): inclusion proofs for every leaf at every tree size to 33, consistency proofs for
every size pair to 24, rewritten history rejected, signed heads. A live run with a witness detected an edited log file and
refused to cosign.
