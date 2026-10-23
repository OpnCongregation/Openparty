// Re-hash every member's lookup hashes under the active pepper, then report.
//   PEPPERS="p0:<hex>,p1:<hex>" PEPPER_ACTIVE=p1 REF_PEPPER_HEX=<the original pepper> DATABASE_URL=... MASTER_KEYS=... npm run rotate-pepper
// When it reports no conflicts and nothing skipped for a bad reason, remove the old pepper from PEPPERS. The REF pepper must NOT change.
import { pepperRingFromEnv } from "./crypto.js";
import { rotatePepper } from "./pepper-rotation.js";
import { createCtx } from "./platform.js";
import { loadKeyProvider } from "./vault-provider.js";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL: rotation works on the real database.");
const peppers = pepperRingFromEnv(process.env);
if (!peppers) throw new Error("Set PEPPERS (and PEPPER_ACTIVE) or PEPPER_HEX.");
if (Object.keys(peppers.keys).length < 2) console.warn("Only one pepper in the ring: nothing to rotate to.");
const keyProvider = await loadKeyProvider(process.env);
if (!keyProvider) throw new Error("Set the master key settings so member records can be read (MASTER_KEYS, MASTER_KEY_HEX or KEY_PROVIDER=vault).");

const ctx = await createCtx({ databaseUrl: process.env.DATABASE_URL, keyProvider, peppers });
console.log(`Active lookup pepper: ${peppers.active}; ring: ${Object.keys(peppers.keys).join(", ")}`);
const r = await rotatePepper(ctx);
console.log(`Re-hashed ${r.rehashed}, already current ${r.alreadyCurrent}, skipped ${r.skipped} (erased or no record), conflicts ${r.conflicts}.`);
await ctx.db.close();
if (r.conflicts) { console.error("Some rows changed while the tool ran. Run it again."); process.exitCode = 1; }
