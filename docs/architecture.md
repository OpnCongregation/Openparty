# Architecture

OpenParty is a framework any political party can adopt to run itself honestly. Each deployment serves **one party**; every member
on it belongs to that party. The code is the same in every country. What changes is data.

## Three layers on an international floor

```
  Party settings      what a party chooses            parties/<party>/settings.yaml
  Country law pack    what the country's law demands   packs/<country>/<version>/pack.yaml
  Universal core      what never changes                services/*  (code)
  International floor the minimum for certification     floor/floor-v1.yaml
```

**The golden rule: a higher layer can only tighten a lower one, never loosen it.** A party may set a lower donation cap than the law,
not a higher one. One exception: where national law *forbids* a feature, the law pack switches it off (in Nigeria s.85 makes screening,
covenant scores and ratings advice only), and no party setting can turn it back on.

| Layer | Holds | Controlled by | Changes |
|---|---|---|---|
| Party settings | name, creed, dues, rating rules, languages, offices, channels | each party | freely, but checked against the law pack before it saves |
| Country law pack | register fields, deadlines, allowed primary types, donation caps, data rules, allowed ID adapters | local counsel, reviewed and signed by the foundation | only when the law or a court ruling changes, each rule with its citation |
| Universal core | secret ballot, one member one vote, encrypted ledger, witnesses, audit trail, separation of powers | the foundation | never by a party or country; only through releases |
| International floor | minimum democratic standards F1 to F12 | the foundation, after consultation | rarely |

### How the layers are joined

`framework/config.ts` loads the floor, the pack and the party file, validates the party against the pack
(`framework/resolve.ts`), and returns one `Config`. Every legal number in the code is read from it, for example
`ctx.config.get("notice.days_before_contest")`. The configuration has a **fingerprint** (floor version + pack hash + party hash) which is
recorded in `deployment_config` and posted to the public log (`framework/deploy.ts`), so anyone can see when a deployment's rules changed.

A pack rule is a bound on a named parameter:

| Operator | Meaning for a party |
|---|---|
| `>=` | may set the value at or above the bound |
| `<=` | may set the value at or below the bound |
| `==` | cannot change it |
| `in` | must choose from the listed values (a list may be narrowed, never widened) |
| `has` | a list must contain at least these items |

`framework/compliance.ts` produces an honest self-assessment: for each pack rule, is it **enforced** by code that reads its parameter,
**partly** enforced, only **declared** (waiting for a module that is not built), or **needs a human** (for example whether a party name has
ethnic meaning). It is a self-assessment, not a certification.

## Services

| Part | Path | Language | Job |
|---|---|---|---|
| Trust log and witness | `services/trustlog` | Go, standard library only | Append-only Merkle log (RFC 6962 style), signed heads, witness cosigning, OpenTimestamps anchoring |
| Platform | `services/platform` | TypeScript, Fastify | Domain logic: membership, register and notice gates, rules, finance, admin, petitions, USSD, the `/framework` API |
| Portal | `apps/portal` | TypeScript, Next.js | Log verifier, Framework, Rules lab, Test results, USSD simulator |

## Pluggable country IDs

The core calls one interface, `IdAdapter` (`services/platform/src/adapters.ts`). An adapter returns only: verified, age check, area and
assurance level, plus attributes that go **only** into the member's encrypted register record. The ID number is turned into a keyed
one-way hash for "one person, one membership". Adapters must pass the public conformance suite
(`test/adapter-conformance.ts`). Built: Nigeria NIN (simulated). Planned: MOSIP, W3C Verifiable Credentials, in-person agent check.

## Privacy by construction

- Per-member encryption keys; erasure destroys the key (the entry stays, unreadable).
- **Database and public log stay in step (outbox).** A change and its public event are written in ONE database transaction
  (`ctx.commit(tx => { write; ctx.events.emit(tx, event) })`); a publisher then copies committed events to the log in order, under an advisory
  lock, right after commit and from a background loop. Each event has a random key (`oid`) and the log ignores a repeated key, so
  retries are safe and a crash between commit and publish only delays the event. `npm run verify:consistency` checks the database against
  every log entry; `/healthz` reports the backlog. Domain code must not call the log directly.
- **Shared state, so more than one platform instance can run.** Rate-limit counters (`rate_limits`, UNLOGGED) and pending joins
  (`pending_joins`, encrypted) live in PostgreSQL; nothing about a request is kept in process memory. The trust log is the exception by
  design: one writer per data directory.
- **Log durability.** `Append` returns only after the record is written and fsynced (and the directory, for a new file). A crash
  mid-append leaves at most one torn final record, which `OpenLog` drops and logs (it was never acknowledged); damage anywhere
  earlier is refused, not repaired. The log is the single writer: one instance per data directory.
- **Public API limits.** `/entries` returns at most 1000 entries or about 4 MiB per call with a `next` cursor; proof requests run
  in at most 8 slots (503 beyond that); each address is rate limited (`RATE_LIMIT_PER_MIN`, default 600); a record over 1 MiB is
  refused with 413; HTTP servers have read, write and idle timeouts. The limiter keys on the connecting address, so behind a
  proxy it sees the proxy: limit at the proxy as well.
- **USSD webhook.** `POST /ussd` exists only when `USSD_WEBHOOK_SECRET` is set, compares it in constant time, optionally checks
  `USSD_ALLOWED_IPS`, validates the payload and rate limits: failed authentications per address, requests per phone, a high ceiling per gateway address (counts shared through the database). `POST /ussd/sim` (no secret) exists only
  when `LAB_ENABLED=1`. A phone number from the gateway is a claim; PIN guesses are limited per account (see the PIN policy below) because
  a 4-digit PIN is only as strong as that limit.
- **Money.** Every dues collection is a `payment_attempts` row written before the provider is called and keyed by the gateway
  session; the provider receives the same idempotency key on retries. `reconcile` reports payments charged but not recorded,
  unconfirmed, or refused after being taken; `POST /admin/finance/retry-payments` finishes the first kind.
- **Approvals** run exactly once. Vote, count and the pending to executing claim are one transaction under a row lock; the action's effects, the `executed` mark, its result and its public event are a second single transaction (on a transaction-scoped context), with the claim token checked inside it. A crash therefore leaves either nothing applied or everything applied; `recoverApprovals` re-claims expired leases (startup and every 30 s, any instance) and finishes them.
- **Which counters may reset.** Must survive a database crash (LOGGED tables): failed gateway authentication (`rate_limits_durable`) and PIN attempts (`pin_attempts`). May reset (UNLOGGED `rate_limits`): per-phone volume, the gateway ceiling, the simulator.
- **PIN policy.** Every guess is recorded before it is compared and a success removes only its own record: 5 failures in a rolling 24 h lock until the oldest ages out, 10 in 30 days lock until a ward agent unlocks (`POST /agent/unlock-pin`). A locked PIN refuses even the right PIN.
- **Key lifecycle.** Master keys live in the software ring or in Vault Transit (`KEY_PROVIDER=vault`); lookup peppers are a rotatable ring, the public-reference pepper is fixed; erasures are replayed after a restore. See [key-management.md](key-management.md).
- PIN hashing (scrypt) runs asynchronously on the thread pool and is the platform's capacity limit; see [load-test.md](load-test.md).
- Crash recovery and power loss: [power-loss-test.md](power-loss-test.md). Master keys: see [key-management.md](key-management.md).
- The public log accepts only listed event types with exactly their listed fields, each in a strict shape (`src/logschema.ts`).
  Free text, nested objects and serialized JSON do not fit a shape. The old key denylist (`assertNoPersonalData`) remains as a second check.
  A new event type or field must be added to the allowlist before it can be logged.
- Admin requests are signed with the person's own key; no shared logins, no super admin, no security role.
- Append-only tables (`finance_ledger`, `rules`, `access_log`, `deployment_config`) are enforced by database triggers.

## What is not built

Voting and tally (ElectionGuard, Semaphore), ratings, tribunal, ombudsman, screening, learning, covenant tracker, election-day operations,
the Flutter and Kotlin apps, an admin web console, register export as PDF, and translations other than English. See the floor
statuses in `floor/floor-v1.yaml` and the pack statuses on the Framework page.
