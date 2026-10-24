# Voting

Two layers. **The ballot box** (below, phase 1) enforces who may stand and vote and counts the votes. **The secret ballot** (section at the end) sits on top of it
when the ElectionGuard service is configured, and is what a real contest must use. Guardians' runbook: `docs/guardians.md`. Everything still to do: `docs/pending-tasks.md`.

What is built, how it behaves, and what it is **not**. The secret-ballot design is in `docs/secret-ballot-recommendation.md`.

> **The plain ballot box is not a secret ballot.** Without the ElectionGuard service the `ballots` table stores the voter next to the choice. Use it only to try the flow.
> With the service configured (`EG_URL`), voting cannot open on an election that has not been **sealed** for the secret ballot (see the last section).

## The rules it enforces

| Rule | Where |
|---|---|
| The ballot (offices) is set by the secretary or electoral committee, before voting opens | `createRace`, `race.manage` |
| **Anyone who registers to compete is a candidate.** Admins cannot refuse them; they can only give a vetting stamp | `registerCandidate`, `stampCandidate` |
| Candidates are **public**: explicit consent, visibility forced to visible, name published on the log, erasure blocked while standing | `registerCandidate`, `members.erase` |
| A race may charge a **form fee**. The candidate is listed when it is paid, in the same transaction as the ledger row (no double charge, no lost payment) | `finance.collectFormFee`, ledger kind `form` |
| Candidacy closes when voting opens; a candidate may withdraw before then (no refund by this code) | `withdrawCandidate` |
| Every admin may stamp a candidate `vetted` or `flagged`, one stamp each. A stamp informs voters and removes nobody | `candidate_stamps` |
| Voting opens only on or after the vote date, with the notice, register and both INEC receipts, approved by two other people | `openContest`, `contest.open` |
| Only members on the **frozen register** who are **still active** may vote | `isEligible`, `castBallot` |
| One ballot per member per office; casting again **replaces** it (last counts); abstaining is an explicit choice | `castBallot` |
| Results are hidden while voting is open and published, with turnout, when the contest closes (same transaction as the close) | `results`, `publishResults` |
| Closing is an approved action and cannot happen before the vote date | `contest.close` |

## Three ways to vote

| Channel | How | Recorded as |
|---|---|---|
| USSD | Menu option 5: PIN, then one screen per office (1-8 candidates, 9 = more, 0 = abstain), then confirm | `ussd` |
| Online | Portal `/election/vote`: phone + PIN, ballot paper, receipt | `web` |
| Ward agent | Portal `/election/unit`: the agent signs in with their own key; the **voter types their own PIN**; the agent must be in the member's ward | `agent` (with the agent's id) |

## HTTP API

Public: `GET /public/election/:contestId` (offices, listed candidates, stamp counts), `GET /public/election/:contestId/results` (423 until closed), `GET /public/time`.

Member (JSON `{phone, pin, ...}`, throttled per address and per member): `POST /election/ballot`, `/election/vote`, `/election/apply`, `/election/pay-form`, `/election/withdraw`, `/election/mine`.
If several contests are open, the ballot goes to the one the member is on the register of.

Signed (admin or agent key, same scheme as the other admin routes): `POST /agent/vote`, `POST /admin/races`, `POST /admin/candidates/:id/stamp`, `GET /admin/election/:contestId`;
open, close and freeze go through `POST /admin/approvals` (`contest.open`, `contest.close`, `register.freeze`).

## Public log events (allowlisted in `logschema.ts`)

`race.created`, `candidate.registered` (the candidate's public name, field `candidate`, letters only), `candidate.listed`, `candidate.withdrawn`, `candidate.stamped` (verdict only, never the note),
`finance.form`, `ballot.cast` (anonymous receipt, channel, revision; **never the voter or the choice**), `race.turnout`, `race.result`.

## Trying it on your machine (demo mode)

`DEMO_MODE=1` (and, because the compose stack runs with `NODE_ENV=production`, `ALLOW_DEMO_IN_PRODUCTION=1`) in your **local, git-ignored** `.env`, then `docker compose up -d --build`.
Open `http://localhost:3001/election/desk`, press **Seed demo admins, members and contest**, and walk the checklist: offices, candidates (Stand for office), stamps, receipts,
register freeze, open (use **Jump to the vote date**), vote online / at the polling unit / by USSD simulator, close, results.
Demo mode seeds fake admins and members into the real database, hands the demo admins' private keys to the browser and moves the clock. The platform refuses it in production unless
overridden. Never use it with real members. Seeding twice leaves earlier demo contests behind; that is expected.

## Known limits of this phase

- **The plain ballot box is not secret** (above). With the service, see the secret-ballot section and its limits.
- **No cap on form fees** (owner decision).
- **A withdrawn candidate's paid fee is not refunded** by this code.
- **Tie-breaks are the constitution's job.** A tie is reported as a tie; no winner is chosen.
- **One choice per office.** No ranked or multi-seat ballots yet.
- **Candidate names** come from the identity check and must be letters only to be published; otherwise the member is asked to see a ward agent.
- English only.

## The secret ballot (phases 2 and 3)

Built on the ElectionGuard reference library (a separate Python service, `services/electionguard`); no cryptography of our own.

**Who holds the keys.** Five **guardians**, all members of the electoral committee for the contest's country, state or municipality. The secretary names them; the **auditor and the tribunal** approve
(so the committee cannot pick its own guardians). Each makes a secret key **on their own device** with `guardian_tool`; the platform only ever sees public messages. **Any three** can open the **total**.
Never a single ballot, and never fewer than three.

**Order of events.** Offices and candidates, then: notice, register frozen, receipts, **appoint guardians** (approved), **key ceremony** (guardians), **seal the election** (approved: the ballot
description is published and fixed; nobody can stand or be added after), open on the vote date, voting, close, **add up the encrypted ballots** (public maths), **three guardians post shares**,
the total opens, results are published and the log carries turnout and per-candidate counts. With the service configured, opening is refused unless the election is sealed.

**Who may vote, and how it stays anonymous (Semaphore).** Every member has one *identity*: a secret plus its public *commitment*. When the election is sealed, the commitments of everyone on the frozen register go into a fixed, sorted, public *group*. A ballot carries a zero-knowledge proof that its sender's identity is in that group, plus a *nullifier*: the same for the same person in this contest (so a second ballot replaces the first) and different in every other contest. The proof is bound to the ballot's own id and the contest, stored with the ballot and published, so anyone can check every counted ballot came from an eligible voter and nobody was counted twice.
- **Device identity (recommended).** The voter's browser makes the identity; only the commitment is registered, once, with the member's PIN, before the election is sealed. Voting is then **anonymous: no login at all**, and nothing the platform holds can say which ballot is theirs.
- **Assisted identity (USSD, polling-unit terminal, web with a PIN).** The platform derives the identity from its permanent reference key, makes the proof in memory and drops the secret. Whoever holds that key can re-derive it, so for these voters the link is protected by the operator's controls, not by mathematics (`docs/pending-tasks.md` A12).
- **Policy.** The register is a snapshot: a member who resigns after the freeze stays eligible if they vote anonymously from a device (they cannot be told apart); platform-identified voters are refused.

**What is stored.** A ciphertext, the nullifier (so a second ballot from the same person replaces the first; the earlier one is marked superseded, not deleted), the membership proof, the channel, the polling unit
(polling-unit ballots only) and the **day**. No member id, no time of day, no serial number. Who has voted is kept in a separate table, with no link to any ballot. Ballots are published in
ballot-code order, not arrival order. The platform cannot show a member what they chose before, only that they voted.

**Paper at polling units.** Every ballot cast at a unit also leaves a paper copy. After the close the ward agent reports the paper count once per unit. The audit compares paper ballots with electronic
ballots per unit, and, once the guardians have also opened the polling-unit total, the paper choices with the electronic ones. Any difference is shown, never hidden.

**Endpoints.** Anonymous: `POST /election/cast` (no credentials; choices and proof). Member: `POST /election/identity` (register a device identity's commitment). Public: `GET /public/election/:id/group`, `GET /public/semaphore/:depth/semaphore.wasm|zkey` (the proving files). Public: `GET /public/config`, `/public/election/:id/record`, `/ballots` (paged), `/audit`, `/verify`. Guardians (signed): `GET /guardian/ceremony/:id`, `POST /guardian/ceremony/:id/key|backups|verify`,
`POST /guardian/shares/:id/:set`. Admin: approved actions `guardians.appoint` and `election.seal`; `POST /admin/contests/:id/tally`. Agent (signed): `POST /agent/paper-count`.
Screens: `/election/guardian`, `/election/audit`, and the new steps on `/election/desk`.

**Trying it locally.** `docker compose up` starts the service (internal only). With `DEMO_MODE=1`, `EG_DEMO_GUARDIANS=1` the desk's *Demo* buttons run the five guardians' steps for you. Tests: `node scripts/test-electionguard.mjs`
runs a whole election (five-guardian ceremony, three channels, a tally opened by three guardians, the independent check, the paper audit) on the real library.

**Honest limits** (full list in `docs/pending-tasks.md`): anonymity is complete for device voters at the database level, but a device voter's *choices* still travel to the server, which encrypts them, so network metadata (IP, timing) can link a request to a person; assisted voters (USSD, terminal) are linkable by whoever holds the platform's reference key; every channel is encrypted **by the server** (the choice is in server memory once), which matters most for USSD voting, which the owner has made binding; all five guardians being electoral-committee members
concentrates trust; the library is slow and old; and no independent audit has been done.
