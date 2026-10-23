// Maintenance steps used by scripts/backup-drill.mjs (the erasure-versus-backups rehearsal). Not part of normal operation.
//   tsx src/backup-drill.ts setup                       create a test member on the live database, print its id
//   tsx src/backup-drill.ts erase <member id>           erase it on the live database
//   tsx src/backup-drill.ts inspect <db name> <id> [--replay]   can the record still be read in that database?
//   tsx src/backup-drill.ts rotate-destroy <restored db> <old backup db> <id>
import { randomBytes } from "node:crypto";
import { HttpTrustLog, MemoryTrustLog } from "./adapters.js";
import { readAllEntries } from "./consistency.js";
import { ErasedError, KeyStore, SoftwareKeyProvider, pepperRingFromEnv } from "./crypto.js";
import { erasedRefsFromEntries, replayErasures } from "./erasure-replay.js";
import { confirmJoin, erase, prepareJoin } from "./members.js";
import { createCtx } from "./platform.js";
import { loadKeyProvider } from "./vault-provider.js";

const [cmd, ...args] = process.argv.slice(2);
const live = process.env.DATABASE_URL;
if (!live) throw new Error("DATABASE_URL is not set");
const urlFor = (name: string) => live.replace(/\/[^/]+$/, `/${name}`);
const keyProvider = await loadKeyProvider(process.env);
const peppers = pepperRingFromEnv(process.env);
if (!keyProvider || !peppers) throw new Error("master key and pepper settings are needed");
// Only the LIVE database publishes to the real public log. Scratch copies get a throw-away in-memory sink, so their outbox rows
// can never be marked published while having gone nowhere (an earlier version of this drill did exactly that to the live database).
const open = (url: string, kp = keyProvider, real = false) =>
  createCtx({ databaseUrl: url, keyProvider: kp, peppers, log: real ? new HttpTrustLog(process.env.TRUSTLOG_URL ?? "", process.env.APPEND_TOKEN ?? "") : new MemoryTrustLog() });
const out = (o: unknown) => console.log(JSON.stringify(o));

async function readable(ctx: Awaited<ReturnType<typeof open>>, id: string): Promise<{ readable: boolean; state: string | null; reason?: string }> {
  const row = (await ctx.db.query<{ state: string; record_enc: string }>("SELECT state, record_enc FROM members WHERE id=$1", [id]))[0];
  if (!row) return { readable: false, state: null, reason: "no such member row" };
  try { await ctx.keys.decrypt(id, row.record_enc); return { readable: true, state: row.state }; }
  catch (e: any) { return { readable: false, state: row.state, reason: e instanceof ErasedError ? "key destroyed (erased)" : String(e.message).slice(0, 90) }; }
}

if (cmd === "setup") {
  const ctx = await open(live, keyProvider, true);
  const nin = String(1 + Math.floor(Math.random() * 9)) + String(Math.floor(Math.random() * 1e10)).padStart(10, "0");
  const phone = `+2348${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  await prepareJoin(ctx, phone, nin);
  const j = await confirmJoin(ctx, phone, "anonymous", "4321");
  out({ memberId: j.memberId });
} else if (cmd === "erase") {
  const ctx = await open(live, keyProvider, true);
  await erase(ctx, args[0]);
  out(await readable(ctx, args[0]));
} else if (cmd === "inspect") {
  const ctx = await open(urlFor(args[0]));
  const before = await readable(ctx, args[1]);
  let replay: unknown = null;
  if (args.includes("--replay")) {
    const refs = erasedRefsFromEntries(await readAllEntries(process.env.TRUSTLOG_URL ?? "http://trustlog:8080"));
    replay = await replayErasures(ctx, refs);
  }
  out({ before, replay, after: args.includes("--replay") ? await readable(ctx, args[1]) : undefined });
} else if (cmd === "rotate-destroy") {
  // A restored backup is rotated to a brand-new master key; an OLDER backup (still wrapped under the old keys) is then tried with
  // only the new key in the ring, as if the old keys had been destroyed. Both databases are scratch copies; the live one is untouched.
  const [restored, older, id] = args;
  const fresh = new SoftwareKeyProvider({ drill: randomBytes(32) }, "drill");
  const ctx = await open(urlFor(restored));
  const oldRing = keyProvider;
  // Rewrap with a ring that can read the old keys AND write the new one.
  const both: any = { software: true, activeId: "drill", keyIdOf: (b: string) => (fresh.keyIdOf(b) === "drill" ? "drill" : oldRing.keyIdOf(b)),
    wrap: (d: Buffer, a: string) => fresh.wrap(d, a), unwrap: (b: string, a: string) => (b.startsWith("v2.drill.") ? fresh.unwrap(b, a) : oldRing.unwrap(b, a)) };
  const ks = new KeyStore(ctx.db, both, peppers);
  const r = await ks.rewrapAll();
  const newOnly = new KeyStore(ctx.db, fresh, peppers);
  ctx.keys = newOnly;
  const afterRotate = await readable(ctx, id);
  const oldCtx = await open(urlFor(older), fresh); // the old backup, with the old keys gone
  const oldBackup = await readable(oldCtx, id);
  out({ rewrapped: r.rewrapped, remaining: r.remaining, restoredCopyWithNewKeyOnly: afterRotate, olderBackupWithOldKeysDestroyed: oldBackup });
} else {
  throw new Error("usage: setup | erase <id> | inspect <db> <id> [--replay] | rotate-destroy <restored> <older> <id>");
}
process.exit(0);
