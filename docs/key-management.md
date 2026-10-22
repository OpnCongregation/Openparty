# Key management

What protects member records, what it does not, and the procedures the code supports. Status: a **software key ring**.
There is no HSM or cloud KMS yet; `ALLOW_SOFTWARE_KEYS=1` is how an operator acknowledges that.

## How it works

- Each member (and each donor) has a random 256-bit **data key**. Their register record is encrypted with it (AES-256-GCM,
  the member id bound in as associated data).
- The data key is stored **wrapped** (encrypted) under a **master key** in the `member_keys` table. A wrapped key looks like
  `v2.<master key id>.<iv>.<tag>.<ciphertext>`. Older rows (`v1...`, written before key ids existed) are read as master key `k0`.
- All use of master keys goes through the `KeyProvider` interface (`src/crypto.ts`). Today's provider is `SoftwareKeyProvider`,
  which holds the keys in the platform process. An HSM or KMS provider implements the same three methods
  (`wrap`, `unwrap`, `keyIdOf`) and nothing else in the platform changes.
- **Erasure** deletes the member's wrapped key. The encrypted record stays but cannot be opened.
- Lookup hashes (id, phone) use a separate **pepper** (`PEPPER_HEX`). Losing it breaks lookups; leaking it makes the hashes guessable.

## What this does not protect against (read this)

| Risk | Why |
|---|---|
| Master key compromise | Anyone with a master key and a copy of the database can open every record wrapped under it. The key lives in process memory and in `.env`. An HSM would stop key extraction; it is not installed. |
| Backups and replicas after erasure | Deleting a row in Postgres does not remove it from backups, replicas, WAL archives or dead tuples awaiting vacuum. A restored backup brings the wrapped key back, and the record opens (this is tested: `the limit, stated as a test`). |
| The pepper | Compromise makes NIN and phone hashes guessable offline (11-digit NINs are a small space). |
| A rogue operator | An operator with database and key access can read records. Separation of duties has to be organisational. |

## Configuration

```
MASTER_KEY_HEX=<64 hex>                 # the original single key; it is key "k0"
MASTER_KEYS=k1:<64 hex>,k2:<64 hex>     # the key ring (ids: letters, digits, - and _)
MASTER_KEY_ACTIVE=k2                    # used for every new wrap
ALLOW_SOFTWARE_KEYS=1                   # required with NODE_ENV=production while keys are software-held
```

With only `MASTER_KEY_HEX` set, behaviour is unchanged. Ids may not contain `.` or `:`.

## Rotating the master key

1. Generate a new key. Add it to `MASTER_KEYS` and set `MASTER_KEY_ACTIVE` to it. **Keep the old key in the ring** (`MASTER_KEY_HEX`
   is `k0`). Restart the platform. New members are wrapped under the new key at once; old rows still open.
2. Rewrap the existing rows: `npm run rotate-keys` in `services/platform` (in Docker:
   `docker compose exec platform npx tsx src/rotate-keys.ts`). It works in batches, can be repeated, and is safe while the platform is
   serving. It prints how many data keys each master key still wraps. A non-zero exit means rows remain under another key.
3. Confirm the old key shows 0 live rows. **Do not destroy it yet** (next section).

## Destroying an old master key (what makes backups safe)

Backups taken before a rotation still contain data keys wrapped under the old master key. Erasure and rotation only change the
live database. The one control that reaches backups is **destroying the master key those backups were wrapped under**:

- Set a backup retention period (for example 35 days) and rotate the master key at least that often.
- Once rotation has finished and **every backup that needs the old key has expired or been destroyed**, delete the old key from
  `.env` / the secret store and from every copy of it. From then on those backups cannot reopen any record, including records
  erased since.
- The cost is real: if you destroy a key while a backup you still want depends on it, that backup's records are gone. Rehearse
  this on a copy first.

## Recovery

- **Lost master key, no copy:** every record wrapped under it is permanently unreadable. Keep the ring in at least two separately
  controlled places (for example a sealed envelope held by two named people, and the secret store). Test that you can start the
  platform from the backup copy alone.
- **Lost pepper:** member lookup by id and phone fails until it is restored. Store it alongside the master keys.
- **Restoring a database backup:** it also restores wrapped keys of members erased after the backup was taken. Re-run the erasures
  recorded on the public log (`member.erased` events) after any restore, before the platform serves traffic. (Not automated.)

## Not done, needed before real members

- An HSM or KMS-backed `KeyProvider`, with non-exportable keys.
- A written backup policy and a restore drill, with the retention period above.
- Automatic replay of erasures after a restore.
- Pepper rotation. It would mean decrypting each record and rehashing its ID and phone under a new pepper; no tool exists for that yet.
