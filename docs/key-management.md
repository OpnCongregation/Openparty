# Key management and the data lifecycle

What protects member records, what it does not, and the procedures the code supports and has rehearsed. Erasure, backups, key
destruction and pepper rotation are one lifecycle: read it as a data-protection procedure, not only a cryptography note.

## How it works

- Each member (and each donor) has a random 256-bit **data key**. Their register record is encrypted with it (AES-256-GCM,
  the member id bound in as associated data).
- The data key is stored **wrapped** (encrypted) under a **master key** in the `member_keys` table. A wrapped key looks like
  `<version>.<master key id>.<payload>`: `v2` is the software key ring, `v3` is Vault Transit, `v1` is the oldest format (read as key `k0`).
- All use of master keys goes through the `KeyProvider` interface (`src/crypto.ts`): `wrap`, `unwrap` (both asynchronous, because a
  real key service is a network call) and `keyIdOf`. Nothing else in the platform touches master key material.
- **Erasure** deletes the member's wrapped key. The encrypted record stays but cannot be opened.
- **Peppers** are the secrets behind lookup hashes, in two kinds on purpose:
  - **Lookup peppers** (a ring; one active) hash national IDs and phone numbers so a member can be found without storing them. They can be rotated.
  - The **reference pepper** (`REF_PEPPER_HEX`, defaulting to the original `PEPPER_HEX`) makes the public-log pseudonyms and the donor keys. It must **not** be
    rotated casually: the public log is permanent and the finance ledger is append-only, so a new one would cut every earlier pseudonym and donor total
    off from later ones. Changing it is a deliberate decision to unlink the past.

## Key providers

| Provider | Setting | Where the master key lives | Status |
|---|---|---|---|
| Software key ring | `MASTER_KEY_HEX` (key `k0`), or `MASTER_KEYS=id:hex,...` + `MASTER_KEY_ACTIVE` | In the platform's memory and `.env` | Works. Not an HSM; a production start refuses it unless `ALLOW_SOFTWARE_KEYS=1`. |
| **HashiCorp Vault Transit** (or OpenBao: same API) | `KEY_PROVIDER=vault`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY` (default `openparty-master`), optional `VAULT_NAMESPACE` | Inside Vault. The platform sends a data key to be encrypted and gets ciphertext back; the master key never leaves. | Built and tested against a real Vault (`node scripts/test-vault.mjs`). No `ALLOW_SOFTWARE_KEYS` needed. |
| AWS KMS, Google Cloud KMS, Azure Key Vault | not built | In the cloud service | Implement `KeyProvider` (three methods). **Not written or tested**: there was no account to test against. |

### Using Vault

1. Run Vault yourself (below), enable the transit engine and create a **derived** key:
   `vault secrets enable transit` then `vault write -f transit/keys/openparty-master derived=true type=aes256-gcm96`.
   The key must be derived: the data key's identity is sent as the derivation context, so a wrapped key copied onto another member's row will not
   unwrap. The platform refuses to start against a key that is not derived.
2. Give the platform a Vault token whose policy allows only `transit/encrypt/openparty-master` and `transit/decrypt/openparty-master`
   (the operator who rotates keys needs `update` on `transit/keys/openparty-master/rotate`, `.../config` and `.../trim`; keep that off the platform's token).
3. Set `KEY_PROVIDER=vault` and the `VAULT_*` settings. Existing data is moved over with `npm run rotate-keys`, which rewraps every row under Vault.
4. `docker compose --profile vault up` starts a **development** Vault (in memory, token `root`) for trying this locally. Do not use it for real data.

**Production Vault is your job:** persistent storage (Raft or similar), TLS, auto-unseal (ideally an HSM or cloud KMS seal so the unseal key is not a file), high
availability, audit logging, least-privilege policies, and a tested recovery of Vault itself. If Vault is lost with no backup, every record wrapped under it is gone.
Vault being down means the platform cannot read or write member records; plan for that.

## What this does not protect against (read this)

| Risk | Why |
|---|---|
| Master key compromise (software ring) | Anyone with a master key and a copy of the database can open every record wrapped under it. With Vault this is replaced by compromise of a Vault token with decrypt rights, which can be revoked and audited. |
| Backups and replicas after erasure | Deleting a row does not remove it from backups, replicas, WAL archives or snapshots. A restored backup brings the wrapped key back and the record opens (shown by the drill below). Two controls close this: replay the public log's erasures after a restore, and destroy old master key versions. |
| Physical remnants | A deleted row's bytes stay on disk as dead tuples until vacuumed and overwritten, in the WAL until recycled, and in any filesystem or volume snapshot. No script here reaches them. The policy therefore relies on key destruction plus **encrypted disks and backups**, not on deletion. |
| The lookup peppers | Compromise makes NIN and phone hashes guessable offline (11-digit NINs are a small space). Rotate with `npm run rotate-pepper`. |
| A rogue operator | An operator with database and key access can read records. Separation of duties has to be organisational. |

## Rotating the master key

Software ring: add the new key to `MASTER_KEYS` and set `MASTER_KEY_ACTIVE` to it (keep the old key in the ring), restart, then `npm run rotate-keys`.
Vault: rotate the transit key in Vault (`vault write -f transit/keys/openparty-master/rotate`), restart the platform (or let it refresh), then `npm run rotate-keys`.
`rotate-keys` rewraps every row in batches, can be repeated, is safe while serving, and prints how many data keys each master key (or key version) still wraps.
A non-zero exit means rows remain under another key.

## Destroying an old master key (what makes backups safe)

Backups taken before a rotation still contain data keys wrapped under the old key. Erasure and rotation only change the live database. The one control that
reaches backups is **destroying the master key those backups were wrapped under**:

- Software ring: delete the old key from `MASTER_KEYS` / `.env` and from every copy of it.
- Vault: raise the minimum decryption version and trim: `vault write transit/keys/openparty-master/config min_decryption_version=N min_encryption_version=N`, then
  `vault write transit/keys/openparty-master/trim min_available_version=N`. Vault then refuses to decrypt anything wrapped by an older version, for everyone, permanently.
- Only do this once `rotate-keys` shows the old version wrapping nothing live **and** every backup that must stay restorable has expired or been destroyed.
  The cost is real: a backup that depends on a destroyed key is gone. Rehearse on a copy first.

### Retention schedule to adopt

| Item | Suggested | Why |
|---|---|---|
| Database backups kept | 35 days | Long enough for operations, short enough to bound exposure |
| Master key rotation | at least every 35 days (and after any suspected exposure) | Each rotation starts a new generation of backups |
| Old key version destroyed | when the last backup that needs it expires, i.e. about 35 days after the rotation that replaced it | Makes expired-by-policy backups unreadable even if a copy survives |
| Backups and snapshots encrypted at rest | always | Covers the physical remnants this code cannot reach |

These are suggestions: set the real numbers with your data-protection adviser and write them down.

## Restoring from a backup

1. Restore the database. **Do not start the platform yet.**
2. Re-apply every erasure the public log records: `npm run replay-erasures` (needs `DATABASE_URL`, `TRUSTLOG_URL`, the master key and pepper settings). It finds each member whose
   pseudonym appears in a `member.erased` entry and destroys their key again. Safe to repeat. It writes no new log entry, since the erasure is already public.
3. Start the platform. Confirm with `npm run verify:consistency`.

## Rehearsal (do this before real members, and after any change to this process)

`node scripts/backup-drill.mjs` on a test stack (needs Docker). It: creates a member; takes a `pg_dump`; erases the member; restores the dump into a scratch database
and shows the erased record **readable again**; replays the log's erasures and shows it unreadable; then rewraps a restored copy under a brand-new master key and shows an
older backup, with the old keys destroyed, **permanently unreadable**. It touches only one test member on the live data and removes its scratch databases.

## Rotating the lookup pepper

1. Add the new pepper to the ring and make it active, keeping the old one: `PEPPERS=p1:<64 hex>`, `PEPPER_ACTIVE=p1`, keep `PEPPER_HEX` (it is `p0`), and set `REF_PEPPER_HEX` to
   the **original** pepper value so public pseudonyms do not change. Restart. Lookups now try both peppers, so nobody is locked out; new members use `p1`.
2. Run `npm run rotate-pepper`: it re-hashes every member's ID and phone under `p1` (compare-and-swap, batched, safe to repeat and on a live system).
3. When it reports no conflicts, remove `p0` from the ring (keep `REF_PEPPER_HEX`). Without step 2, dropping the old pepper would lose every member (tested).

## Recovery

- **Lost master key, no copy** (software ring) or **lost Vault**: every record wrapped under it is permanently unreadable. Keep key material in at least two separately controlled
  places and test starting from the backup copy alone.
- **Lost pepper:** member lookup by ID and phone fails until it is restored. Store peppers beside the master keys. Losing the reference pepper breaks pseudonym lookup used by `replay-erasures`.
- **Vault unavailable:** the platform cannot read or write encrypted records until it returns. Run Vault highly available.

## Not done, needed before real members

- A **production** Vault (or other KMS/HSM) deployment, with an HSM or cloud-KMS seal. AWS/GCP/Azure providers are not written.
- A written backup policy using the schedule above, backups encrypted at rest, and a restore drill on the real infrastructure (the script rehearses the logic, not your backup system).
- Automation of the post-restore steps in your runbook (the commands exist; running them is manual).
- Erasing physical remnants already captured in old snapshots or WAL archives.
