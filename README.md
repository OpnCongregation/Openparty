# OpenParty

OpenParty is a free framework that helps a political party run itself honestly. It builds the party's own rules into the system, so no leader can quietly bend them.

## The problem

In many parties, a few people hold the member list, the money and the vote count. Members cannot check any of it. Rules get changed late at night. Lists are padded. Results are announced, not shown.

OpenParty takes that power out of private hands. Every important action leaves a public record that anyone can check, and big decisions need more than one person.

## How it works

Think of three layers, one on top of the other.

1. **The international floor.** Basic standards of fair democracy, such as one member one vote and equal chances for women, people with disabilities and minorities.
2. **The country law pack.** The election and party laws of one country, written as checkable rules. Each rule names the law it comes from.
3. **The party's own settings.** The party's name, dues, terms of office and so on.

**Rules can only get stricter.** A party may set a lower limit on donations than the law allows. It may never set a higher one. If a party tries to loosen a rule, the system will not start. The one exception is where a country's law bans a feature. There, the law pack switches that feature off.

## Core and modules

Some parts are always on. Nobody can turn them off. Other parts are modules. Each party chooses which ones to use, in its settings file.

| Part | What it does | Can it be turned off? |
|---|---|---|
| **Membership** | One person, one member. Private details stay private. | No. Core. |
| **Trust log** | A public record that shows if anything was altered. | No. Core. |
| **Approvals** | Big actions need a second person. No super admin. | No. Core. |
| **Law pack checks** | Every setting is checked against the law. | No. Core. |
| **Finance** | Records gifts and dues. Refuses anonymous, foreign and over-limit money. Donor reports. | Yes |
| **Petitions** | Members can raise a proposal. If enough sign, leaders must answer in public by a set date. | Yes |
| **USSD** | Join, pay dues and check your card from a basic phone. No data needed. | Yes |
| **Voting** | Candidates come forward and are vetted. Members vote online, at a polling unit or by phone. Results are published. | Yes |
| **Secret ballot** (the Voting Guard) | Ballots are protected by ElectionGuard. Five guardians each hold a key. Any 3 of the 5 must work together to open the count. No one person can. Anyone can run a public check on the result. Needs Voting. | Yes |

If a module is off, its pages and addresses do not exist. A module you do not list is off. See [docs/modules.md](docs/modules.md) for how to switch each one on.

## Who it is for

- **Party officials** who want rules that members can trust.
- **Funders** who want to back parties that can show their books and their votes.
- **Civil society groups and observers** who want to check a party without asking permission.
- **Members** who want to know that their vote and their data are safe.

## Try the demo

You need Docker. Then:

```
cp .env.example .env
docker compose build && docker compose up -d
```

Open http://localhost:3001. Look at `/party` for a sample party page, `/lab` for the rules at work, and `/election` for voting. The sample party is the Digital Democratic Party of Nigeria (DDPN). It is a made-up example and is not registered with any authority.

The first start needs a few secret keys filled in. Full steps are in the [developer guide](docs/developers.md).

## Status

> **Please read before you rely on it.**
>
> - It has **not yet been independently audited** for security.
> - The Nigeria **law pack has not been reviewed by a lawyer**. It is a draft. Nothing here is legal advice.
> - **ID checks, text messages and payments are simulated.** Real providers still have to be connected.
> - Voting has not yet been used in a real election. Do not run it for real members yet.
>
> The honest, rule-by-rule account is in the [developer guide](docs/developers.md) and in [docs/roadmap.md](docs/roadmap.md).

## Licence

The code is free to use under [Apache-2.0](LICENSE). The documents, law packs and party settings are under [CC BY 4.0](LICENSE-DOCS). Because the licence is open, anyone may copy the code. The protection against a fake "OpenParty" is the name and a public register of parties that keep the safeguards on. See [GOVERNANCE.md](GOVERNANCE.md).

## How to help

The most useful help is honest criticism.

- **Lawyers:** review a country law pack.
- **Security experts:** try to break it.
- **Translators:** native speakers of Hausa, Yoruba, Igbo and other languages.
- **Anyone:** read the rules and tell us what is unclear or wrong.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and the [code of conduct](CODE_OF_CONDUCT.md).

For setting it up, see the [developer guide](docs/developers.md).
