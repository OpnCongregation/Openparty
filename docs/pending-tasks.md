# Pending tasks (as of 2026-10-24, after the anonymous membership proof)

What is built and tested: ballot box, public candidates with vetting stamps and form fees, voting by USSD, web and ward agent, five guardians drawn from the electoral committee,
a real ElectionGuard key ceremony, encrypted ballots, a tally opened by any three guardians, an independent re-check, a paper audit, and screens for all of it
(`docs/voting.md`, `docs/guardians.md`, `docs/secret-ballot-recommendation.md`). The owner's decisions are recorded at the end.

**Do not run a real contest yet.** Items marked **BLOCKER** must be done first.

## A. Secrecy and verification (the cryptography)

| # | Task | Why |
|---|---|---|
| A1 | **BLOCKER. Independent cryptographic and security audit** of the whole ballot path (this code and the ElectionGuard integration) | Nobody independent has reviewed it |
| A2 | **Anonymous membership proof (Semaphore): BUILT for device voters** (a voter whose identity is made on their own phone casts with no login; no database, key or log the platform holds can link the ballot to them). **Not yet for USSD and terminal voters**: their identity is derived by the platform (see A12) | The one remaining cryptographic link between voter and ballot |
| A3 | **Encrypt on the voter's own device** (browser, WebAssembly) with the Benaloh spoil check. The membership proof is now made in the browser, but the CHOICES still travel to the server, which encrypts them (ElectionGuard has no browser library). The request is unauthenticated, so the database cannot link it, but the network can (IP address, timing) | The choice is in server memory once; metadata links a request to a voter |
| A4 | **USSD is binding (owner decision), so its secrecy rests on procedure.** Build: voting key in an HSM or Vault unlocked by the PIN, no logging of the choice anywhere on the path, witnessed key-use log, and ask the SMS/USSD gateway about retention | A feature phone cannot encrypt; the server must |
| A5 | **BLOCKER. Legal opinion** on binding electronic and USSD voting for internal primaries (Electoral Act, INEC guidelines) | Owner chose binding; the law decides if it is allowed |
| A6 | Verify each guardian's **decryption proofs** in the independent check, and have an outside party build a verifier from the ElectionGuard specification (the current check covers ballot proofs and that the tally is the sum) | Anyone should be able to check the whole count |
| A7 | Guardian composition: all five are electoral-committee members (owner decision). Three colluding could decrypt individual ballots. Consider two independent guardians (tribunal, auditor, civil society) or a higher quorum | Concentration of trust |
| A8 | Derive the assisted voters' identities inside Vault or an HSM, not from the platform's reference key (see A12) | Defence in depth |
| A11 | **Network metadata for anonymous casts**: IP address and timing can link a request to a person. Options: Tor or a relay, batching and random delay, a mixnet. Do not log IPs on `/election/cast` | Anonymity at the network layer |
| A12 | **Assisted identities are derivable by the operator.** For USSD and polling-unit voters the secret is derived from the permanent reference key and the member id, used in memory and dropped, but anyone holding that key and the database can re-derive every assisted identity and nullifier and so link assisted ballots to members | Operator-trusted channels (and USSD is binding) |
| A13 | **Revoking a voter during a contest.** A member who resigns or is erased after the register freeze stays eligible (a device voter, being anonymous, cannot be told apart; removing them means re-rooting the group, and every voter's proof then changes). Platform-identified voters are still refused | Policy: the register is a snapshot |
| A14 | **Protect the identity on the device**: today it is in browser storage, readable by any script on that origin. Use passkeys or encrypt at rest with a key from the PIN; offer a printed QR backup; lost devices can only be reset by a ward agent BEFORE the election is sealed | A lost or copied identity |
| A15 | The proof is bound to the ballot's id, not to its choices (TLS protects the choices in transit). Binding to the ciphertext needs A3 | Integrity of the request |
| A16 | **Trust in the proving artifacts**: the Semaphore circuits and keys come from the project's trusted-setup ceremony and are pinned by SHA-256 here. Review the ceremony transcript; plan depths above 20 (up to 32) if a register could exceed one million | Provenance |
| A17 | Verification cost: about 40 ms per ballot; a million ballots is about 11 hours on one core. Parallelise the public check | Speed |
| A18 | Elections sealed before this change (in the local demo database) have no group of voters and cannot be voted in | Demo data only |
| A9 | Remove timing and metadata links: shuffle published ballots (mixnet or batching), do not log IPs on voting routes, check gateway logs | Ballots are stored by day and published in code order, but IPs and gateway logs are outside our database |
| A10 | Upgrade path: ElectionGuard 1.4.0 (2022, Python 3.10 only) to a maintained release or the C++ implementation; pin dependency hashes; SBOM | The library is old and logs secrets at INFO (we switch logging off) |

## B. Guardians and the ceremony

| # | Task | Why |
|---|---|---|
| B1 | **BLOCKER. A witnessed, rehearsed key ceremony** with all five guardians on their own devices (not the demo shortcut), recorded, with each guardian's private file backed up in two places | The demo runs all five in one process |
| B2 | **Ceremony reset.** If a backup fails to verify, the ceremony must be redone: there is no reset or re-appointment flow yet | Today a failed ceremony strands the contest |
| B3 | Guardian absence handling: reminders to guardians on count day, a deadline, and a procedure if fewer than three can ever take part | If 3 or more keys are lost the count can never open |
| B4 | Hardware keys (WebAuthn / HSM) for admin and guardian signing; today keys are software, held in a browser or file | Phishing and theft |
| B5 | Contest and admin **jurisdiction** (country, state, municipality): the columns and the check exist, but nothing sets them (no API or screen); only SQL | Required for the owner's rule that guardians come from the right committee |

## C. Counting and audit

| # | Task | Why |
|---|---|---|
| C1 | **Risk-limiting audit** with random selection of paper ballots, and a per-unit choice-level comparison. Built: per-unit ballot totals and an all-units choice comparison | Statistical assurance, not only totals |
| C2 | Paper process: printing the slip at the terminal, the box, chain of custody, who counts. The software only records the counts | Paper is manual today |
| C3 | Paper for **online and USSD** votes does not exist (paper audits only the polling-unit channel). The owner chose digital as primary | Those channels are audited by the encryption proofs only |
| C4 | Tie-breaking and multi-seat or ranked offices (one choice per office today); tie is reported, not resolved | Constitution decides |
| C5 | Performance: the Python library takes roughly seconds per ballot. Load-test, parallel workers, batch jobs, the C++ library | Large electorates |

## D. Candidates and money

| # | Task | Why |
|---|---|---|
| D1 | Refund policy and mechanism for a withdrawn candidate's form fee (none today) | Owner decision, then code |
| D2 | **No cap on form fees (owner decision).** Recorded. Consider publishing every office's fee before candidates register (it is already public) | Transparency |
| D3 | Ballot order is by registration time; consider alphabetical or random per voter to avoid first-position bias | Fairness |
| D4 | Candidate names must be letters only to be published; a record with other characters asks the member to see an agent | Edge cases |

## E. Platform, deployment and records

| # | Task | Why |
|---|---|---|
| E1 | **BLOCKER. Production deployment**: TLS reverse proxy, firewall, monitoring, backups with the key-destruction schedule, Vault with HSM or cloud-KMS seal (`docs/key-management.md`) | Local Docker only |
| E2 | Real **USSD/SMS gateway, national ID service and payment gateway** (all simulated) | Nothing real is connected |
| E3 | Hausa, Yoruba and Igbo text for USSD and SMS (English only) | Language |
| E4 | PRD section 22 and the traceability matrix still describe the earlier build; update | Documentation |
| E5 | Push the local commits and **revoke the exposed GitHub token** | Housekeeping |
| E6 | Clean the local demo data (fake members, contests, public-log entries) and turn the demo flags off before any real use | Your local stack holds demo data |
| E8 | **Dependency hygiene.** Merge Dependabot's pull requests as they come (each runs the full suite first); re-check the `overrides` in the root `package.json` whenever Semaphore releases; run `npm audit` and `pip-audit` before every release. ElectionGuard 1.4.0 itself is old and pins old packages, which is why the Docker build prints a pip resolver warning (harmless: it is installed without its declared dependencies on purpose) | Vulnerabilities in packages we ship |
| E7 | Admin screens: contest creation, guardian reminders, tally progress notifications | Today some actions are API-only |

## Owner decisions recorded
- **USSD voting is binding.** (A4, A5 follow.)
- **Guardians:** five members of the electoral committee for the country, state or municipality; appointed by the secretary and approved by the auditor and the tribunal. (A7 follows.)
- **ElectionGuard as a Python service:** accepted.
- **Polling units keep paper ballots for auditing; the primary means of voting is digital.**
- **No cap on form fees.**
