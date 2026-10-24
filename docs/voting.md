# Voting: phase 1 (the ballot box)

What is built, how it behaves, and what it is **not**. The secret-ballot design is in `docs/secret-ballot-recommendation.md`.

> **Not a secret ballot.** The `ballots` table stores the voter next to the choice, so anyone with database access can see who voted for whom.
> The public log shows only counts and anonymous receipts. Use this phase to try the flow and test the gates. Do not run a real contest on it.

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

- **Not secret** (above). **Not receipt-free in the strong sense:** the receipt proves a ballot was counted and reveals no choice, but the database can still link voter and choice.
- **No legal cap on form fees.** `createRace` honours an optional pack setting `candidacy.max_form_fee_minor`; the bundled Nigeria pack sets none (owner decision).
- **A withdrawn candidate's paid fee is not refunded** by this code.
- **Tie-breaks are the constitution's job.** A tie is reported as a tie; no winner is chosen.
- **One choice per office.** No ranked or multi-seat ballots yet.
- **Candidate names** come from the identity check and must be letters only to be published; otherwise the member is asked to see a ward agent.
- English only.
