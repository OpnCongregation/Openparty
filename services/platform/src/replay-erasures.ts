// Re-apply the erasures recorded on the public log to a database restored from backup. Run before the platform serves traffic.
//   DATABASE_URL=... TRUSTLOG_URL=http://localhost:8080 MASTER_KEYS=... PEPPER_HEX=... npm run replay-erasures
import { readAllEntries } from "./consistency.js";
import { erasedRefsFromEntries, replayErasures } from "./erasure-replay.js";
import { pepperRingFromEnv } from "./crypto.js";
import { createCtx } from "./platform.js";
import { loadKeyProvider } from "./vault-provider.js";

if (!process.env.DATABASE_URL || !process.env.TRUSTLOG_URL) throw new Error("Set DATABASE_URL and TRUSTLOG_URL.");
const keyProvider = await loadKeyProvider(process.env);
const peppers = pepperRingFromEnv(process.env);
if (!keyProvider || !peppers) throw new Error("Set the master key and pepper settings (the same ones the platform uses).");
const ctx = await createCtx({ databaseUrl: process.env.DATABASE_URL, keyProvider, peppers });
const refs = erasedRefsFromEntries(await readAllEntries(process.env.TRUSTLOG_URL));
const r = await replayErasures(ctx, refs);
console.log(`The log records ${refs.size} erasures. Checked ${r.checked} live members; re-applied ${r.replayed}.`);
await ctx.db.close();
