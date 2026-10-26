# Modules: switching parts of OpenParty on and off

OpenParty is built in two layers.

- **The core** is always on. It cannot be turned off, by anyone, in any party.
- **Modules** are extra features. A party turns on the ones it wants, and leaves the rest off.

## What is always on (the core)

| Core part | What it does |
|---|---|
| Membership | One person, one member. Joining, the member card, keeping personal details private, leaving the party. |
| The trust log | The public, tamper-evident record that anyone can check. |
| Approvals | Big actions (changing rules, freezing a register, opening or closing a contest) need a second person. |
| Law pack checks | Every setting is checked against the country's law pack. A party may be stricter than the law, never looser. |

Contests, the paperwork gates (notice, register freeze, receipts) and the background jobs that keep approvals and
record notices moving belong to the core too, because the law's timetable applies whether or not you run votes on this
platform.

If you write one of these names in the `modules:` list (for example `membership: false`), the platform refuses to
start and tells you it is core.

## The five modules

### `finance`: money in
Records gifts and donations, produces the donor report for the treasurer and auditor, retries payments that did not
reach the public log, and reconciles the ledger. The rules about who may give and how much (no anonymous, foreign or
over-cap gifts) are law pack checks and stay on whatever you choose.
Turn it off if the party does not handle money on this platform.

### `petitions`: members' proposals
Lets anyone see how a member proposal is doing: how many members have signed, whether it reached the threshold, and
the date by which the leadership must answer in public.
Turn it off if the party does not want proposals run here.

### `ussd`: the feature-phone gateway
Lets members join, pay dues and look up their card by dialling a short code on any phone, with no smartphone or data.
With this off, the USSD address on the platform does not exist, and the platform does not need a gateway secret to start.
Turn it off if the party reaches members only by app or web.

### `voting`: candidates and ballots
Candidates put themselves forward, the electoral committee stamps them, members vote (online, at a polling unit through
a ward agent, or by USSD if that is on), and results are published when an approved close happens. Form fees for
candidates are part of this module.
This is an ordinary ballot box: the platform can tell who voted and how, so it is **not** a secret ballot. Read
[voting.md](voting.md).

### `secret_ballot`: a vote nobody can trace back
Adds the machinery that separates *who voted* from *what they voted*: the anonymous proof of membership, the guardians
who must work together to open the count, the public record that anyone can re-check, and the paper audit at polling
units. Its honest limits are in [roadmap.md](roadmap.md) and [secret-ballot-recommendation.md](secret-ballot-recommendation.md).

**It needs `voting`.** If `secret_ballot` is on and `voting` is off, the platform refuses to start. It also needs the
ElectionGuard service running (`EG_URL`); without it, voting falls back to the plain ballot box and the platform says so
when it starts.

## How to turn a module on or off

1. Open your party's settings file, `parties/<party>/settings.yaml` (for the reference party, `parties/ddpn/settings.yaml`).
2. Find the `modules:` section, or add it (put it above `profile:`).
3. Write `true` for each module you want, `false` for each one you do not.

```yaml
modules:
  finance: true
  petitions: false
  ussd: true
  voting: true
  secret_ballot: false
```

4. Restart the platform. The settings are read once, at start.

Things to know:

- **A module you do not list is off.** If the whole `modules:` section is missing, every module is off. Turning
  something on is always something you wrote down.
- **A typo stops the start.** Unknown names (`votng`), values that are not `true` or `false`, and the core names are all
  refused, with a message saying which line is wrong. Better a loud stop than a module quietly staying off.
- **Changing modules changes the party's configuration fingerprint**, so the change is recorded on the public log the next
  time the platform starts, like any other setting change.

## What "off" means

- **The platform:** the module's addresses do not exist. Asking for one gets a plain `404 Not Found`, the same as any
  address that was never there. Its background jobs are not started. Nothing about it is half-on.
- **The portal:** the module's pages disappear from the menu, and a person who types the address in gets a short note
  that the module is not turned on for this party.
- **Existing data is kept.** Turning a module off does not delete anything it recorded, and the public log is untouched.
  Turning it on again brings the pages back with the old records.

## Seeing what is on

Open `/public/modules` on the platform. It lists every module as on or off, plus the core parts. The portal reads
this to decide which pages to show.

```json
{
  "modules": { "finance": true, "petitions": true, "ussd": true, "voting": true, "secret_ballot": true },
  "core": ["membership", "trust_log", "approvals", "law_pack_checks"]
}
```

The platform also prints one line at start, for example `modules on: finance, ussd, voting; jobs: approval recovery,
record notices`.

## Known limits

- Modules switch off **addresses and jobs**. A few behaviours inside the core still reach into a module's area: the
  USSD menu (when `ussd` is on) still shows the dues option even if `finance` is off, and candidates' form fees are
  charged through the payment machinery even if `finance` is off. If your party turns `finance` off, tell your ward
  agents and treat those two as unused.
- The party page in the portal (`/party`) is rendered from the party's settings and still describes dues, donor limits
  and petitions whether or not those modules are on.
- The `/lab` scenarios and the demo routes (`DEMO_MODE`) are test tools and are not governed by modules.
