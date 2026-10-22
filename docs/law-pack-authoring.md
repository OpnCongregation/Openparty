# Writing a law pack

A law pack turns one country's party law into rules the system can check, each with its citation. The Nigeria pack
([`packs/ng/v1/pack.yaml`](../packs/ng/v1/pack.yaml)) is the reference; copy its shape.

> A pack is **legal text turned into code**. Have a lawyer admitted in that country review it before anyone relies on it.
> The bundled Nigeria pack is a draft that has not had that review.

## Layout

```
packs/<country>/<version>/pack.yaml        the rules
packs/<country>/<version>/pack.yaml.sig    optional foundation signature (hex)
parties/<party>/settings.yaml              a reference party on the pack
```

## Header

```yaml
id: NG                 # short pack id, referenced by party files
version: "1.0"
name: Nigeria
status: draft          # draft | in force; keep "draft" until counsel has reviewed it
country: NG
regulator: INEC        # the body parties file with; shown to members in plain words
currency: { code: NGN, symbol: N, minor_unit: kobo, minor_per_unit: 100 }
default_locale: en
```

## Parameters

`params` lists every number or list the core reads, with the pack's default. A rule can only mention a declared parameter.

```yaml
params:
  notice.days_before_contest: 21
  notice.modes: [virtual, in_person]
  finance.cap_per_donor_minor: 50000000000     # always in minor currency units
```

The parameters the core understands are listed in `ENFORCED_BY` in `services/platform/src/framework/compliance.ts`. If your country needs
a rule the core has no parameter for, the rule is still valid: it is reported as **declared** (not yet enforced) until a module reads it.

## Rules

```yaml
- id: NG-REG-01                    # <country>-<topic>-<nn>; never reuse an id
  title: Register filed at least 21 days before a contest
  rule:                            # one expression, or a list; all must hold
    - register.days_before_contest >= 21
    - register.export_format == pdf_read_only
  effect: Contest cannot open without the filing receipt
  source: Electoral Act 2026 s.77(4); INEC Regulations 2026 Reg 4(3)   # REQUIRED: the pack will not load without a citation
  floor: F2                        # which international floor rule this serves
  status: in force
```

Operators: `>=`, `<=`, `==`, `in`, `has` (see [architecture](architecture.md)). A party's settings must satisfy **every** rule on a
parameter, so "tighten, never loosen" is automatic.

A rule a machine cannot judge uses `check: attest` with an `attest:` sentence. It is shown as **needs human review** and never counted
as enforced (for example "the name has no ethnic or religious meaning").

## Features the law switches off

```yaml
features_off:
  - key: eligibility.party_criteria_allowed
    effect: Screening, covenant and ratings are advisory only
    source: Electoral Act 2026 s.85
```

The parameter must be declared; its pack value is final and no party setting can change it.

## Checking your work

```
npm run validate:packs      # loads the floor, every pack and every party file; fails on any error or loosened setting
npm test                    # the framework tests include "every pack rule cites a source and a real floor rule"
```

Every rule should have a test that proves the system refuses what the rule forbids. Look at `test/acceptance.test.ts` and
`test/layers.test.ts` for the pattern. The synthetic `packs/_test/testland` pack exists to prove that the core obeys the pack it is given
rather than Nigeria.

## Signing (foundation only)

```
node scripts/sign-pack.mjs keygen
node scripts/sign-pack.mjs sign packs/ng/v1/pack.yaml <seed-hex>
```

Deployments verify the signature when `FOUNDATION_PUBKEY` is set. An unsigned pack is reported as unsigned. No foundation key exists yet.

## Citing honestly

Quote the section number, not a summary. If a rule is your reading of a clause rather than the clause itself, say so in `effect` or set
`status: draft`. Reviewers will check every citation against the source.
