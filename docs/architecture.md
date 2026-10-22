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
- The public log refuses personal-data keys (`assertNoPersonalData`).
- Admin requests are signed with the person's own key; no shared logins, no super admin, no security role.
- Append-only tables (`finance_ledger`, `rules`, `access_log`, `deployment_config`) are enforced by database triggers.

## What is not built

Voting and tally (ElectionGuard, Semaphore), ratings, tribunal, ombudsman, screening, learning, covenant tracker, election-day operations,
the Flutter and Kotlin apps, an admin web console, register export as PDF, and translations other than English. See the floor
statuses in `floor/floor-v1.yaml` and the pack statuses on the Framework page.
