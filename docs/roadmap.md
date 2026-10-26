# Roadmap

What must happen before OpenParty runs a real contest, what we plan to improve, and what the owner has already decided.
Codes in brackets (A1, B2 and so on) are the original task codes, kept so older notes still match.

**Do not run a real contest yet.**

## Must do before real use

1. **Independent security and cryptography audit** of the whole ballot path: this code and the ElectionGuard link. Nobody independent has reviewed it. (A1)
2. **Legal opinion** on binding electronic and USSD voting for internal primaries (Electoral Act, INEC guidelines). The owner chose binding; the law decides whether it is allowed. (A5)
3. **A witnessed key ceremony** with all five guardians on their own devices, recorded, with each private file backed up in two places. The demo runs all five in one process. (B1)
4. **Production deployment:** TLS proxy, firewall, monitoring, backups with a key-destruction schedule, and Vault with a hardware or cloud-KMS seal (see [key-management.md](key-management.md)). Today it runs on local Docker only. (E1)
5. **Real providers** for national ID, SMS and USSD gateway, and payments. All are simulated now. (E2)

## Planned improvements

### Secret ballot
- Give USSD and polling-unit voters an anonymous proof too. Today their identity is derived by the platform, so the operator could link their ballots. (A2, A12, A8)
- Encrypt the choice on the voter's own device, so it never sits in server memory. Needs a browser ElectionGuard library. (A3, A15)
- Hide network traces of anonymous votes: no IP logging on voting routes, then a relay, batching or a mixnet. (A11, A9)
- Protect the voter's identity on the device with a passkey or a PIN-derived key, and offer a printed QR backup. (A14)
- Check each guardian's decryption proofs, and have an outside party build their own verifier from the ElectionGuard specification. (A6)
- Review the Semaphore trusted-setup transcript, and plan larger group sizes if a register could pass one million. (A16)
- Speed up the public check, now about 40 ms per ballot. (A17)
- Move off ElectionGuard 1.4.0 (2022, Python 3.10 only) to a maintained release or the C++ version, and pin dependency hashes. (A10)
- Decide the policy for members who resign after the register freezes: today they stay eligible. (A13)

### USSD
- Protect USSD secrecy by procedure: voting key in a hardware module or Vault unlocked by the PIN, no logging of the choice, a witnessed key-use log, and a check of the gateway's data retention. (A4)
- Hausa, Yoruba and Igbo menus and messages. English only today. (E3)

### Guardians
- Consider two independent guardians (tribunal, auditor, civil society) or a higher quorum, because three electoral-committee guardians colluding could read individual ballots. (A7)
- A ceremony reset and guardian re-appointment flow. A failed backup check currently strands the contest. (B2)
- Reminders, a deadline and a fallback procedure for guardian absence. If three or more keys are lost, the count can never open. (B3)
- Hardware keys (WebAuthn or HSM) for admin and guardian signing. (B4)
- Screens and an API to set a contest's or admin's jurisdiction (country, state, municipality). Only SQL can today. (B5)

### Voting and counting
- Risk-limiting audit with random paper-ballot selection and choice-level comparison per unit. (C1)
- Paper process: printing the slip, the box, chain of custody, who counts. (C2)
- A paper trail for online and USSD votes. Today only polling-unit votes have paper. (C3)
- Tie-breaking, plus multi-seat and ranked offices. Ties are reported, not resolved. (C4)
- Faster counting for large electorates: parallel workers and batch jobs. (C5)
- Randomise or alphabetise ballot order to avoid first-position bias. (D3)

### Finance
- A refund policy and mechanism for a withdrawn candidate's form fee. Needs an owner decision first. (D1)

### Admin
- Screens for contest creation, guardian reminders and tally progress. Some actions are API-only today. (E7)

## Decisions made

- **USSD voting is binding.** The legal opinion (A5) and USSD secrecy work (A4) follow from this.
- **Guardians** are five members of the electoral committee for the country, state or municipality, appointed by the secretary and approved by the auditor and the tribunal. (A7 follows.)
- **ElectionGuard may run as a Python service.**
- **Polling units keep paper ballots for auditing.** The main way to vote is digital.
- **No cap on form fees.** Every office's fee is public before candidates register. (D2)
