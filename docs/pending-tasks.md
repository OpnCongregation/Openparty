# Pending tasks (as of 2026-10-24, after the secret-ballot build)

What is built and tested: ballot box, public candidates with vetting stamps and form fees, voting by USSD, web and ward agent, five guardians drawn from the electoral committee,
a real ElectionGuard key ceremony, encrypted ballots, a tally opened by any three guardians, an independent re-check, a paper audit, and screens for all of it
(`docs/voting.md`, `docs/guardians.md`, `docs/secret-ballot-recommendation.md`). The owner's decisions are recorded at the end.

**Do not run a real contest yet.** Items marked **BLOCKER** must be done first.

## A. Secrecy and verification (the cryptography)

| # | Task | Why |
|---|---|---|
| A1 | **BLOCKER. Independent cryptographic and security audit** of the whole ballot path (this code and the ElectionGuard integration) | Nobody independent has reviewed it |
| A2 | **Anonymous membership proof (Semaphore).** Today the nullifier (what makes a re-vote replace the earlier ballot) is a keyed hash made by the platform, so someone holding the platform's secret key and the database can re-derive which ballot belongs to a member | The one remaining link between a voter and a ballot |
| A3 | **Encrypt on the voter's own device** (browser, WebAssembly) with the Benaloh spoil check, for online voters. Today every channel is encrypted by the server, so the choice passes through server memory once | Removes the operator from the secrecy of online votes |
| A4 | **USSD is binding (owner decision), so its secrecy rests on procedure.** Build: voting key in an HSM or Vault unlocked by the PIN, no logging of the choice anywhere on the path, witnessed key-use log, and ask the SMS/USSD gateway about retention | A feature phone cannot encrypt; the server must |
| A5 | **BLOCKER. Legal opinion** on binding electronic and USSD voting for internal primaries (Electoral Act, INEC guidelines) | Owner chose binding; the law decides if it is allowed |
| A6 | Verify each guardian's **decryption proofs** in the independent check, and have an outside party build a verifier from the ElectionGuard specification (the current check covers ballot proofs and that the tally is the sum) | Anyone should be able to check the whole count |
| A7 | Guardian composition: all five are electoral-committee members (owner decision). Three colluding could decrypt individual ballots. Consider two independent guardians (tribunal, auditor, civil society) or a higher quorum | Concentration of trust |
| A8 | Make the nullifier key live in Vault (HMAC) so a database thief who also has the app host cannot re-derive nullifiers | Defence in depth until A2 |
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
| E7 | Admin screens: contest creation, guardian reminders, tally progress notifications | Today some actions are API-only |

## Owner decisions recorded
- **USSD voting is binding.** (A4, A5 follow.)
- **Guardians:** five members of the electoral committee for the country, state or municipality; appointed by the secretary and approved by the auditor and the tribunal. (A7 follows.)
- **ElectionGuard as a Python service:** accepted.
- **Polling units keep paper ballots for auditing; the primary means of voting is digital.**
- **No cap on form fees.**
