# Guardians: the five people who can open the count

Plain-language runbook for the five guardians, and for the secretary who runs the election around them. The cryptography is the ElectionGuard
reference library; nothing here is our own cryptography. Design background: `docs/secret-ballot-recommendation.md`.

## What a guardian is, and is not

- A guardian is **one of five members of the electoral committee** (for the country, state or municipality the contest is in). The secretary names the five;
  the **auditor and the tribunal** approve. The committee cannot choose its own guardians.
- Each guardian makes a **secret key on their own device**. The platform never sees it. Together the five public halves make the election key every ballot is encrypted to.
- **Any three of the five** can open the **total**. One or two cannot open anything. Even all five opening the total learn only the total, not a single ballot's choice
  (unless three or more of them deliberately decrypt individual ballots, which is why the ballots are anonymous: see "What this does not protect against").
- If two guardians are absent on count day, the other three still finish. If **three or more** lose their keys, **nobody can ever open the count**. Back keys up.

## Before the election

1. **The secretary appoints the five** (approved action *Appoint the five guardians*, approved by the auditor and the tribunal). Done on the admin desk.
2. **Each guardian makes their key** (below). It takes a minute. Do it on a laptop you control, ideally offline.
3. **The key ceremony**: all five post their public key; each makes an encrypted backup for each of the other four; each checks the four backups made for them.
   If **any** check fails, **stop** and tell the secretary: the ceremony is redone. When all five confirm, the platform makes the election key.
4. **The secretary seals the election** (approved by the auditor and the tribunal). This fixes the offices and candidates and publishes the ballot description.
5. **Back up your private file in two places** (for example two encrypted USB drives held by different people). It is the only copy of your key.

## The guardian tool

No installation beyond Docker. On your own device, in a folder you will use only for this:

```
docker build -t openparty-eg path/to/openparty/services/electionguard     # once; or load the image the secretary gives you
alias gt='docker run --rm -v "$PWD:/data" -w /data openparty-eg python -m app.guardian_tool'
gt init    --id <your admin id> --seq <your position> --n 5 --quorum 3 --out me.private.json --public-out me.public.json
gt backups --private me.private.json --keys all-public-keys.json --out-private me.private.json --out backups.json
gt receive --private me.private.json --backups backups-for-me.json --out-private me.private.json --out verifications.json
gt shares  --private me.private.json --manifest manifest.json --context context.json --tally tally-all.json --keys all-public-keys.json --out my-shares.json
```

The **Guardians** page (`/election/guardian`) shows the exact command for your next step, offers the public files to download, and takes the output file you paste back.
**Only** `me.public.json`, `backups.json`, `verifications.json` and `my-shares.json` are ever uploaded. **`me.private.json` is never uploaded.**
(For a fully offline guardian: run the tool with `--network none` and carry the files by USB.)

## Count day

1. Voting closes (approved action). The secretary, an electoral-committee member or the auditor presses **Add up the encrypted ballots**: public maths on ciphertext, nothing is decrypted.
2. Each guardian downloads the manifest, context, tally and keys, runs `gt shares`, and posts `my-shares.json`. The tool computes your share **and** a stand-in share for each other
   guardian, so any three of you can finish whoever is absent.
3. When the **third** guardian posts, the platform combines the shares and opens the **total**. Results appear; the log gets `tally.opened`, `race.turnout` and `race.result`.
4. If the paper audit is used, repeat step 2 for the polling-unit total (`tally-agent.json`) so it can be compared with the paper.
5. Anyone can then run the independent check on the **Audit** page.

## If something goes wrong

| Problem | What to do |
|---|---|
| A backup does not verify in the ceremony | Stop. Do not post. Tell the secretary; the guardians are re-appointed and the ceremony redone (not yet automated: **reset flow is pending**). |
| A guardian loses their private file before count day | The other four can still open the total (any three). Do not proceed to open the election if fewer than four keys are safe. |
| Three or more private files are lost | The count can never be opened. This is why two backups each are required. |
| A guardian posts shares for the wrong tally | The platform refuses shares that are not the guardian's own. Re-run `gt shares` with the right tally file. |
| You suspect your device was compromised | Tell the secretary before the ceremony. After the ceremony a compromised key cannot be changed: that election's key stands. Rotate for the next contest. |

## What this does not protect against

- **All five guardians are on the electoral committee** (an owner decision). Three of them colluding could decrypt individual ballots. The ballots carry no voter identity, but with the
  platform's nullifier key and the database, the operator and three guardians together could in principle re-link a ballot to a member. The usual remedy is guardians from
  independent bodies (the original design had the tribunal, the auditor and two civil-society witnesses); consider adding at least two independent guardians.
- **USSD and polling-unit ballots are encrypted by the server** (those voters cannot encrypt on their own device), so the choice passes through server memory once.
- **Timing and network metadata** (IP addresses, SMS gateway logs) can link a voter to a time even though the ballot is anonymous.
- The platform's own admin keys, and a guardian's, are software keys held in a browser or file, not hardware keys.
