# Developer guide

Set-up, ports, settings and tests for people who run or change OpenParty. For a plain-language overview, see the [README](../README.md).

## How the code is laid out

- `services/trustlog`: the public log and witness (Go, standard library only).
- `services/platform`: all the rules and the API (TypeScript, Fastify). Uses Postgres, or an embedded Postgres when `DATABASE_URL` is not set.
- `services/electionguard`: the ElectionGuard service for the secret ballot (Python).
- `apps/portal`: the web pages (Next.js).
- `floor/`, `packs/`, `parties/`: the international floor, country law packs and party settings.
- More in [architecture.md](architecture.md). To add a country, see [law-pack-authoring.md](law-pack-authoring.md). Modules are explained in [modules.md](modules.md).

## What the portal shows

| Page | What it shows |
|---|---|
| `/framework` | the layers, the floor, every pack rule (enforced, declared, or needs a human), the DDPN settings, and a box to test a setting against the law |
| `/lab` | scenarios replayed step by step in a throwaway sandbox with a virtual clock |
| `/tests` | the results of the last full test run |
| `/ussd` | a feature-phone simulator |
| `/election` | candidates, voting, guardians and the public audit |
| `/` | the home page: one card per module that is on, each linking to its demo |
| `/tour` | a guided demo tour: join, pay dues, open a contest, vote, count, verify |
| `/verify` | a browser-side verifier for the public log |

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

Testing: `node scripts/test-vault.mjs` runs the Vault key-service tests against a real Vault in Docker; `node scripts/backup-drill.mjs`, `scripts/crash-durability.mjs` and `scripts/chaos-approvals.mjs` rehearse backups/erasure and database and platform crashes on the running stack; `npm run report` runs everything on embedded Postgres; `node scripts/test-postgres.mjs` runs the platform suite on a real PostgreSQL 16 in Docker; `npm run verify:consistency` (in `services/platform`) checks the database against the public log; see [load-test.md](load-test.md) and [power-loss-test.md](power-loss-test.md).

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

## Using another law pack or party

`PACK_PATH=/path/pack.yaml PARTY_PATH=/path/settings.yaml`. A party that loosens its pack will not start. Turn features on or off with the `modules:` section of the party settings.

## Status in detail

**Simulated, to replace before real use:** national ID verification, SMS, payments, and the hardware security module (a software key stands in). Real vendors plug in behind the adapter interfaces in `services/platform/src/adapters.ts`.

**Not built:** ratings, tribunal, ombudsman, screening, learning, covenant tracker, the mobile apps, an admin web console, register export as PDF, and any language other than English. Full list: [roadmap.md](roadmap.md).

**Outside checks still to do** (product requirements, section 20): legal opinion, data protection review, security audit and red team, bug bounty, protocol proofs, independent count, paper audit, INEC monitoring, field usability and load tests.

Voting is built. Its limits are in [voting.md](voting.md) and [roadmap.md](roadmap.md).
