# Recommendation: how to implement the secret ballot

**Status (2026-10-24): largely built.** Owner decisions: USSD voting is **binding**; the five guardians are members of the **electoral committee** for the country, state or municipality; the Python ElectionGuard service is accepted;
polling units keep **paper** for auditing while the **primary means of voting is digital**; **no cap** on form fees.
**Built:** the anonymous ballot store (no member id), ElectionGuard encryption, the five-guardian ceremony with a guardian tool, sealing, tally opened by any three, public record and independent re-check, paper audit.
**Anonymous membership proof (Semaphore): built (2026-10-24)** for voters with a device identity; assisted identities (USSD, terminal) are derived by the platform. **Not built (see `docs/roadmap.md`):** encryption on the voter's own device, an HSM-held voting key for USSD, decryption-proof verification, ceremony reset, an independent audit.
The rest of this document is the original recommendation, kept as the reasoning.

## What "secret ballot" must mean here

1. **Secrecy:** nobody, including the operators, the guardians or a database thief, can tell how a member voted.
2. **One member, one vote:** only people on the frozen register vote, once each (re-voting replaces, last counts).
3. **Verifiable count:** anyone can check that every counted ballot was cast by an eligible member, that nothing was dropped or added, and that the total is the sum.
4. **Coercion resistance (as far as software can):** a voter cannot prove how they voted, so buying or forcing a vote does not pay.

No single technique gives all four on every channel. The recommendation is layered, and honest about the channel where it cannot be done.

## Do not write our own cryptography

Use ElectionGuard (open specification, independent verifiers) for the encrypted count and Semaphore (zero-knowledge membership proof) for anonymous eligibility, as the PRD already says.
A home-made scheme cannot be shown correct by testing and has no public spec for anyone else to verify against. Phase 1 stays TypeScript; ElectionGuard runs as one small isolated service.

## The design

### 1. Separate "who voted" from "what was voted" (do this first; it is phase 2)
- At casting the voter proves **membership of the contest's group without saying who they are** (Semaphore): the group is built from the frozen register; the proof yields a per-contest **nullifier**.
- The ballot box stores `(nullifier, encrypted ballot, proof, coarse time)`. **No `member_id` in `ballots`.** A second ballot with the same nullifier replaces the first, which is how re-voting works without identity.
- A separate record says **that** a member voted (turnout, so the register can show "voted" and double-casting by channel can be detected) but carries no link to the ballot. Store only a coarse time (hour) on both, and publish ballots in sorted, not arrival, order, so timing cannot rejoin them.
- Ballot receipts stay "counted"; the receipt is a hash of the ciphertext, which proves inclusion and reveals nothing.

### 2. Encrypt the ballot and count it encrypted (phase 3)
- ElectionGuard: the ballot is encrypted **on the voter's device** (exponential ElGamal) with the election public key and carries a proof that it is well-formed. Ballots are added up **while still encrypted**; only the **total** is decrypted.
- **Five guardians** (electoral committee, tribunal, auditor, two civil-society witnesses), each holding a key share; **any three** decrypt the total, never single ballots. Their keys live on their own hardware, never on the platform.
- A **key ceremony** before opening (recorded, witnessed) and a **decryption ceremony** after the approved close. Both are events on the public log. Fits the existing approvals model: the guardians' quorum is one more approved action.
- Voters can run the **spoil check** (Benaloh challenge): the device encrypts, the voter may challenge it to prove it encrypted what they picked, then re-encrypts for real. This catches a cheating voting app.

### 3. Publish everything except identities (public verification)
The election manifest, guardian public keys, every encrypted ballot with its proof and nullifier, the encrypted tally, each guardian's decryption share with its proof, and the plain tally. Anyone can run an independent verifier. Add a **risk-limiting audit** where paper exists (polling units).

### 4. Per channel (this is where the honest limits are)

| Channel | Can it be truly secret? | Recommendation |
|---|---|---|
| **Online (browser or app)** | Yes, with the above: encryption and the membership proof are made on the voter's own device (WebAssembly in the browser) | Primary electronic channel. Needs a reasonably modern phone. |
| **Polling unit (in person)** | Best of all channels. Supervised; no one can watch the screen | **Keep always open** (PRD). The voter marks the ballot alone on their own phone or a kiosk; the agent never sees the choice. Where paper is used, count it and audit electronic tallies against it. |
| **USSD (feature phone)** | **Not by mathematics alone.** A feature phone cannot do the proof or encryption, so the server must do them for the voter | Offer it, but state the limit plainly. Reduce it: the voting key sits in an HSM, unlocked only by the voter's PIN; the server encrypts to the election key at once; the voter-to-ballot mapping is **never written down**; every key use is logged where witnesses can see it. Secrecy then rests on the HSM, the logging and separation of duties, not on maths. A legal and political decision whether USSD votes are binding or advisory. |

### 5. Coercion and vote buying
Re-voting (last counts) lets a coerced voter vote again in private; supervised in-person voting stays open as the stronger remedy; receipts show only "counted", never the choice. No per-voter proof of choice is ever issued.

## What to change in this codebase

| Step | Change |
|---|---|
| Phase 2 | `ballots`: drop `member_id`, add `nullifier`; add a turnout table with no link; Semaphore group per contest built at `register.freeze`; `castBallot` takes a proof and nullifier; `isEligible` is replaced by proof verification; USSD path uses an HSM-held key (`KeyProvider`/Vault is the existing hook) |
| Phase 3 | ElectionGuard service (Python, own container, no internet, no database): manifest, encrypt (browser WASM or HSM for USSD), tally, decrypt-with-quorum, verifier export; guardian actions as approvals; new log events (`election.keys_published`, `tally.decrypted`, ...) allowlisted in `logschema.ts` |
| Phase 4 | Polling-unit kiosk mode, paper audit, EC16B output, election-day operations, independent verifier published |

Keep what phase 1 already does right: the register and receipt gates, approved open/close, the public candidate list, the anonymous `ballot.cast` events, results only after close.

## Risks that remain whatever we build

- **Metadata:** IP addresses, SMS and USSD gateway logs, and timing can link a voter to a ballot outside our database. Do not log them for voting routes; ask the gateway about retention; batch and order ballots.
- **The operator:** for USSD, and for any device the voter does not control, a malicious operator or compromised phone can see the choice. Procedures, HSMs, witnesses and audits reduce this; they do not remove it.
- **Endpoint compromise** (malware on the voter's phone) is outside the system's reach.
- **Software supply chain:** pin and review dependencies; the verifier must be built independently of the platform.
- **The first real contest** should be small or advisory, with paper alongside.

## Before a real contest

1. An **independent cryptographic and security audit** of the whole ballot path and of the ElectionGuard integration.
2. A **legal opinion** on electronic and USSD voting for internal primaries under the Electoral Act and INEC guidelines.
3. A written **guardian ceremony** and a rehearsal with all five.
4. A **public verifier** run by someone outside the project against a rehearsal election.
5. A decision on **USSD**: binding, advisory, or not offered.

## Decisions needed from you

1. Is USSD voting binding, advisory, or off for the first contest?
2. Who are the five guardians, and who holds the hardware keys?
3. Is a second language service (Python for ElectionGuard) acceptable to operate?
4. Is paper at polling units required alongside the electronic count?
