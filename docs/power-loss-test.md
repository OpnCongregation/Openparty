# Power-loss test of the trust log

What this covers, what it does not, and how to run the part that needs a real power cut.

## What is already tested (in this repository, no hardware needed)

| Test | What it shows | What it cannot show |
|---|---|---|
| `faultfs_test.go` (400 random trials) | Against a disk that forgets everything not yet synced, every acknowledged entry survives; a half-written last record is recovered in four ways (dropped, partly kept, garbage, zero-filled); the first entry survives because the directory is synced; a failed sync or short write is never acknowledged; damage before the last record is refused. | That a real disk or filesystem honours `fsync`. This tests the **order** of the log's writes and syncs, not the hardware. |
| `crash_test.go` (30 SIGKILLs of a real appending process) | The log reopens after the process dies at an arbitrary point; every acknowledged entry is present; the root equals a clean rebuild. | Power loss. After a process kill the operating system still holds unsynced data. |
| `scripts/chaos.mjs` | Killing the platform, log and database in the Docker stack mid-traffic loses nothing and leaves the database and public log in agreement. | Same: process crashes, not power. |

## What needs a real power cut (owner-run)

Drives and filesystems can lie about `fsync` (write caches without battery protection, some virtual disks, some network
filesystems). Only cutting power on the real storage stack finds that. Do it on the same kind of host and volume you will deploy on.

**Use a scratch log, never production.** The test writes junk entries.

1. On the host, start a scratch log with its own data directory and an `APPEND_TOKEN`:
   `DATA_DIR=/srv/scratch-log APPEND_TOKEN=... ./trustlog`
2. On a **different** machine, run the client. It appends entries and writes every acknowledged index to `acked.txt`, flushing the file each time:
   `node scripts/powerloss-client.mjs --log http://LOG-HOST:8080 --token ... --out acked.txt`
3. Cut power to the log host while the client is running: pull the plug or use the hypervisor's "power off" (not "shut down"). Repeat several times, at different moments.
4. Power the host back on. **Do not start the log yet.** Copy `acked.txt` to the host and run:
   `trustlog verify -file /srv/scratch-log/log.jsonl -acked acked.txt`
   - `"ok": true` = every entry the log promised is on disk. `tornTailBytes` above 0 is normal: a half-written, never-acknowledged record.
   - `"ok": false` with `LOST DATA` = the storage lost an acknowledged write. The log's ordering is correct (see above), so the storage or its configuration is at fault: disable the volatile write cache, change the filesystem or mount options, or use different storage. Re-test.
   - An error saying the file is corrupt and naming `trustlog repair`: damage that is not a simple torn tail (for example stale blocks containing newlines after the last synced record). The file was not changed. See below.
5. Start the log. It drops a torn final record by itself. Run `verify` again, then repeat from step 2 using the same data directory, at least ten cycles. The root should keep matching a clean rebuild.

Record the result (host, storage, filesystem, number of cycles, outcome) in your deployment notes. PRD section 20 lists this as an outside check.

## If the log refuses to start after a crash

The log only repairs the final record on its own. If the earlier part of the file is damaged it refuses to start, because it cannot tell
corruption of old, acknowledged entries from junk after a crash. Look first (`trustlog verify -file ...` changes nothing). If the damage
is only trailing junk after the last good entry:

`trustlog repair -file log.jsonl -yes`

This cuts the file back to the last readable record and saves the removed bytes beside it as `log.jsonl.removed-<time>`. It will not run without `-yes`.
A witness that cosigned a longer log will raise a **TAMPER: log shrank** alarm: that is the safeguard, since repairing cannot hide
lost acknowledged entries. Resolve the alarm with the witness operators before treating the repair as complete.

## Not covered

- Power loss in **PostgreSQL**: that is PostgreSQL's own durability (WAL, `fsync`, `synchronous_commit`). Leave those at their defaults and test the volume the same way.
- Loss of the whole disk: needs backups and the key procedures in [key-management.md](key-management.md).
