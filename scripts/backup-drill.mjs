#!/usr/bin/env node
// Erasure versus backups, rehearsed on the Docker stack. Shows, step by step, what a database backup does to an erasure and how
// the recorded procedure (replay the public log's erasures; destroy old master keys) restores the guarantee.
//
//   node scripts/backup-drill.mjs
//
// It creates one test member on the stack's live database and two scratch databases (drill_restore, drill_old) in the same
// PostgreSQL server, and removes the scratch databases and the dump file at the end. The live data is never rewrapped or changed
// except for that one test member.
import { execFileSync } from "node:child_process";

const dc = (...a) => execFileSync("docker", ["compose", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
const pg = (...a) => dc("exec", "-T", "postgres", ...a);
const tsx = (...a) => { const o = dc("exec", "-T", "platform", "npx", "tsx", "src/backup-drill.ts", ...a).trim().split("\n"); return JSON.parse(o[o.length - 1]); };
const problems = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) problems.push(msg); };
const step = (s) => console.log(`\n${s}`);

try {
  step("1. Create a test member on the live database");
  const { memberId } = tsx("setup");
  console.log(`   member ${memberId}`);

  step("2. Take a backup (pg_dump) while the member exists");
  pg("pg_dump", "-U", "postgres", "-d", "openparty", "-Fc", "-f", "/tmp/drill.dump");

  step("3. Erase the member on the live database (their key is destroyed)");
  const erased = tsx("erase", memberId);
  check(!erased.readable && erased.state === "erased", `live database: record unreadable (${erased.reason})`);

  step("4. Restore the backup into a scratch database, as after a disaster");
  for (const db of ["drill_restore", "drill_old"]) {
    try { pg("psql", "-U", "postgres", "-c", `drop database if exists ${db}`); } catch {}
    pg("psql", "-U", "postgres", "-c", `create database ${db}`);
    pg("pg_restore", "-U", "postgres", "-d", db, "/tmp/drill.dump");
  }
  const restored = tsx("inspect", "drill_restore", memberId);
  check(restored.before.readable === true, "restored backup: the erased member's record is READABLE again (the known limit: backups keep the wrapped key)");

  step("5. Replay the erasures recorded on the public log");
  const fixed = tsx("inspect", "drill_restore", memberId, "--replay");
  console.log(`   replayed ${fixed.replay.replayed} erasure(s) (checked ${fixed.replay.checked} live members)`);
  check(fixed.replay.replayed >= 1, "replay found the erasure on the public log and re-applied it");
  check(!fixed.after.readable && fixed.after.state === "erased", `restored backup after replay: record unreadable again (${fixed.after.reason})`);

  step("6. Master key rotation and destruction: an OLDER backup becomes permanently unreadable");
  const rd = tsx("rotate-destroy", "drill_restore", "drill_old", memberId);
  console.log(`   rewrapped ${rd.rewrapped} data keys in the restored copy under a new master key`);
  // The member was erased by the replay above in drill_restore, so readability there is expected to be gone; the point is the OLD backup.
  check(rd.remaining === 0, "every data key in the restored copy now sits under the new master key");
  check(!rd.olderBackupWithOldKeysDestroyed.readable, `older backup with the old master keys destroyed: unreadable (${rd.olderBackupWithOldKeysDestroyed.reason})`);

  console.log("\nWhat this shows: deleting a key does not reach copies in backups; replaying the public log's erasures does, once the backup is restored; and");
  console.log("destroying the old master key makes every backup wrapped under it permanently unreadable. Physical remnants (dead tuples, WAL, snapshots)");
  console.log("are not touched by any of this: see docs/key-management.md.");
} finally {
  for (const db of ["drill_restore", "drill_old"]) { try { pg("psql", "-U", "postgres", "-c", `drop database if exists ${db}`); } catch {} }
  try { pg("rm", "-f", "/tmp/drill.dump"); } catch {}
}
console.log(problems.length ? `\n${problems.length} problem(s).` : "\nAll drill checks passed.");
process.exit(problems.length ? 1 : 0);
