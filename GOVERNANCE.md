# Governance

## Status

OpenParty is at an early stage. **No foundation exists yet.** This file records what the product requirements say the governance
will be, and what is true today.

| | Intended (product requirements, section 11) | Today |
|---|---|---|
| Steward | A foundation owns the code, approves releases, runs security reviews, appoints no party officials and certifies parties | Maintained by the project's contributors; no legal entity |
| Board | No single party controls it | Not formed |
| Floor changes | Public consultation and a board supermajority | Edited in `floor/floor-v1.yaml` by maintainers, in public |
| Law packs | Local counsel, reviewed and signed by the foundation | Draft; unsigned; **not reviewed by counsel** |
| Certification | Independent certifiers run the conformance suite | None. No deployment is certified |

## The licence, and what it does and does not protect

The code is under **Apache-2.0**. The product requirements originally proposed a licence that keeps changes public (AGPL-3.0). The
project chose Apache-2.0 for the public repository, which is permissive: anyone may fork the code, change it and keep their
changes private.

What that means for the safeguards:

- The licence does **not** stop a fork from turning a safeguard off.
- What protects the safeguards is the **name and the certification**. A deployment is "OpenParty certified" only while the locked safeguards are on and its settings fingerprint is on its public log; certification is listed in the [public registry](registry/deployments.json). A fork that removes a safeguard can still use the code, but not the name.
- Documentation, law packs, the floor and party settings are CC BY 4.0, so a reader can always see the rules a deployment claims to follow.

Whether to adopt a copyleft licence later is an open decision for the foundation once it exists.

## Layers and who may change them

1. **International floor** (`floor/`): minimum democratic standards. Cannot be switched off by a law pack or a party.
2. **Universal core** (`services/`): secret ballot, one member one vote, encrypted ledger, witnesses, audit trail, separation of powers.
3. **Country law pack** (`packs/<country>/`): the country's party law as rules with citations.
4. **Party settings** (`parties/<party>/`): a party's own choices, checked against the pack.

A higher layer can only tighten a lower one. The one exception: where national law forbids a feature, the law pack switches it off.

## Decisions

Until a board exists, decisions are made in public by maintainers in issues and pull requests. Changes to the floor or to the
"never loosen" rule need a stated reason and a long comment period.

## Code of conduct and security

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
