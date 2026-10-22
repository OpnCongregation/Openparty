// Compare the database with the public log and say whether they agree.
//   DATABASE_URL=... TRUSTLOG_URL=http://localhost:8080 npm run verify:consistency
// Exit 0 = consistent, 1 = a problem was found, 2 = could not check.
import { readAllEntries, verifyConsistency } from "./consistency.js";
import { openDb } from "./db.js";

const url = process.env.TRUSTLOG_URL;
if (!process.env.DATABASE_URL || !url) {
  console.error("Set DATABASE_URL and TRUSTLOG_URL.");
  process.exit(2);
}
try {
  const db = await openDb(process.env.DATABASE_URL);
  const rep = await verifyConsistency(db, await readAllEntries(url), { maxPendingSeconds: Number(process.env.MAX_PENDING_SECONDS ?? 120) });
  await db.close();
  console.log(JSON.stringify(rep, null, 2));
  process.exit(rep.ok ? 0 : 1);
} catch (e: any) {
  console.error("Could not check:", e?.message ?? e);
  process.exit(2);
}
