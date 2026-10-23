# OpenParty

An open framework any political party can adopt to run itself honestly, and to let ordinary people take part, in any country.

The rules are built into the system, so no chairman, governor or founder can quietly change a register, a result or a rule. Every
important action leaves a public, tamper-evident trace. Joining, paying dues and (later) voting work on a basic phone through USSD.

> **Status: pre-release reference implementation, open for public review.** It has had no independent security audit, and several
> parts are simulated (national ID checks, SMS, payments, the hardware key store). The Nigeria law pack is a **draft that has not been
> reviewed by counsel** and nothing here is legal advice. Do not run it for real members. See [Honest status](#honest-status).
>
> **This is not an electronic voting system.** Voting, ballot secrecy, one-member-one-vote at the ballot, tallying and coercion
> resistance are not built. The signed log shows that recorded events were not altered; it does not prove who voted, that ballots
> were secret, or that a count was right. Do not present it as production-ready for any real election.

## The idea: three layers on an international floor

| Layer | What it holds | Who controls it |
|---|---|---|
| **Party settings** | name, creed, dues, rating rules, languages, offices | each party, freely, but checked against the law pack before it saves |
| **Country law pack** | register fields, deadlines, allowed primary types, donation caps, data rules, allowed ID systems, each rule with its citation | local counsel, reviewed and signed by the foundation |
| **Universal core** | secret ballot, one member one vote, encrypted ledger, witnesses, audit trail, separation of powers | the foundation, only through releases |
| **International floor** | minimum democratic standards F1 to F12 (ICCPR, Venice Commission/ODIHR, CEDAW, CRPD, African Charter) | the foundation, after public consultation |

**The golden rule: a higher layer can only tighten a lower one, never loosen it.** A party can set a lower donation cap than the
law, not a higher one. The one exception: where national law forbids a feature, the law pack switches it off.

Included:

- **Nigeria law pack** (`packs/ng/v1`, NG v1.0 draft): 26 rules citing the Electoral Act 2026, INEC Regulations 2026 and the NDPA 2023.
- **DDPN** (`parties/ddpn`): the Digital Democratic Party of Nigeria, a reference party, *not registered with INEC*, showing a complete set of settings.
- **Testland** (`packs/_test`): a fictional pack used only by tests, proving the core has no country hard-coded.
- **International floor** (`floor/floor-v1.yaml`) and a **public registry** format (`registry/`).

More in [docs/architecture.md](docs/architecture.md). To add a country, see [docs/law-pack-authoring.md](docs/law-pack-authoring.md).

## What works today (P0)

Membership with one-person-one-membership; the register and notice gates that stop a contest opening without its deadlines and receipts;
rules that lock once a notice is out; dues and donor rules (no anonymous, foreign or over-cap money); a witnessed public log with
signed heads; separation of powers with signed admin requests and no shared logins; petitions; USSD join, dues and card; erasure by
destroying a member's key; and a pluggable ID-adapter interface with a public conformance suite.

## Try it

Open the portal after starting the stack (below):

| Page | What it shows |
|---|---|
| `/framework` | the layers, the floor, every pack rule (enforced, declared, or needs a human), the DDPN settings, and a box to test a setting against the law |
| `/lab` | 16 scenarios replayed step by step in a throwaway sandbox with a virtual clock |
| `/tests` | the results of the last full test run |
| `/ussd` | a feature-phone simulator |
| `/` | a browser-side verifier for the public log |

## Run it

### With Docker

```
cp .env.example .env     # then fill the keys: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                         # also set USSD_WEBHOOK_SECRET (16+ chars): the USSD webhook refuses callers that do not send it,
                         # and the platform will not start without it unless LAB_ENABLED=1 (demo; then only /ussd/sim works)
docker compose build
LOG_KEY=x docker compose up -d trustlog    # the log makes its key on first start; LOG_KEY is a placeholder here
docker logs openparty-trustlog-1           # copy key=<hex> and set it as LOG_KEY in .env
docker compose up -d                       # witnesses can now start
```

Testing: `node scripts/test-vault.mjs` runs the Vault key-service tests against a real Vault in Docker; `node scripts/backup-drill.mjs`, `scripts/crash-durability.mjs` and `scripts/chaos-approvals.mjs` rehearse backups/erasure and database and platform crashes on the running stack; `npm run report` runs everything on embedded Postgres; `node scripts/test-postgres.mjs` runs the platform suite on a real PostgreSQL 16 in Docker; `npm run verify:consistency` (in `services/platform`) checks the database against the public log; see [docs/load-test.md](docs/load-test.md) and [docs/power-loss-test.md](docs/power-loss-test.md).

Ports: log 8080, platform 3000, portal 3001. In `docker-compose.yml` these are published on `127.0.0.1` only. To serve other machines, put a TLS-terminating reverse proxy in front and expose only the routes it needs (never the admin routes, the log's append endpoint or the lab); do not simply change the bind address. The Rules lab and Test results need `LAB_ENABLED=1` in `.env`; leave it at `0` outside demos.
Data lives in named volumes; `docker compose down` keeps it, `down -v` wipes it (and the log key). Two witnesses on one host are a demo only.

### Without Docker

```
npm install
# terminal 1: the log
cd services/trustlog && go build -o trustlog . && APPEND_TOKEN=dev DATA_DIR=./data ./trustlog log
# terminal 2: the platform (embedded Postgres; dev keys are random per run, set MASTER_KEY_HEX and PEPPER_HEX to keep data)
cd services/platform && TRUSTLOG_URL=http://localhost:8080 APPEND_TOKEN=dev LAB_ENABLED=1 npm start
# terminal 3: the portal
cd apps/portal && npm run dev        # http://localhost:3001
```

To use another law pack or party: `PACK_PATH=/path/pack.yaml PARTY_PATH=/path/settings.yaml`. A party that loosens its pack will not start.

## Tests

```
npm run report            # runs every suite and writes reports/latest.json (browse it at /tests)
npm test                  # platform and portal
(cd services/trustlog && go test ./...)
npm run test:tools        # tests for the report and publish-check scripts
npm run validate:packs    # every pack and party file is well formed, cited, and obeys its pack
```

## Log anchoring

By default the log writes only a local note and the portal labels it **not an external proof**. Setting `ANCHOR_MODE=opentimestamps`
sends the log head's 32-byte hash to public OpenTimestamps servers, which anchor it in Bitcoin. Only the hash leaves the machine; it is
free and needs no wallet. A proof is pending until a Bitcoin block includes it (usually hours); download it from `GET /anchors/<name>.ots`
and check it with the `ots` client. The log does not verify the Bitcoin block itself, and the code has not yet been run against the real
calendar servers.

## Honest status

**Simulated, to replace before real use:** national ID verification, SMS, payments, and the hardware security module (a software key
stands in). Real vendors plug in behind the adapter interfaces in `services/platform/src/adapters.ts`.

**Not built:** voting and tally (ElectionGuard, Semaphore), ratings, tribunal, ombudsman, screening, learning, covenant tracker,
election-day operations, the mobile apps, an admin web console, register export as PDF, and any language other than English (native
speakers are needed; machine translation of political wording is not accepted).

**Outside checks still to do** (product requirements, section 20): legal opinion, data protection review, security audit and red team,
bug bounty, protocol proofs, independent count, paper audit, INEC monitoring, field usability and load tests.

The [Framework page](#try-it) and `floor/floor-v1.yaml` give the same account rule by rule.

## Licence

Code: [Apache-2.0](LICENSE). Documentation, law packs, the floor and party settings: [CC BY 4.0](LICENSE-DOCS).
Apache-2.0 is permissive, so the licence alone does not stop a fork from turning a safeguard off; the protection is the name and the
public certification registry. See [GOVERNANCE.md](GOVERNANCE.md).

## Contributing

Critical review is the most useful contribution: legal review of a pack, security review, new law packs, ID adapters and native-speaker
translations. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and the [code of conduct](CODE_OF_CONDUCT.md).
