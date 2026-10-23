import type { Ctx } from "./context.js";
import { ErasedError } from "./crypto.js";
import type { RegisterRecord } from "./members.js";

/**
 * Re-hash every member's national ID and phone number under the ACTIVE lookup pepper (see PepperRing in crypto.ts).
 * Lookups try every pepper in the ring, so the system keeps working while this runs; when it reports nothing left, the old
 * pepper can be removed from the ring. Each row is updated only if it still has the hashes this run read (compare-and-swap), so
 * it is safe to run twice, on a live system, and next to a member rejoining. Erased members have nothing to re-hash.
 * Not touched, by design: public-log pseudonyms and donor keys (the REF pepper), which must stay stable (docs/key-management.md).
 */
export async function rotatePepper(ctx: Ctx, batch = 200): Promise<{ rehashed: number; alreadyCurrent: number; skipped: number; conflicts: number }> {
  const out = { rehashed: 0, alreadyCurrent: 0, skipped: 0, conflicts: 0 };
  let after = "";
  for (;;) {
    const rows = await ctx.db.query<{ id: string; id_hash: string | null; phone_hash: string | null; record_enc: string | null }>(
      "SELECT id, id_hash, phone_hash, record_enc FROM members WHERE state <> 'erased' AND id > $1 ORDER BY id LIMIT $2", [after, batch]);
    if (!rows.length) return out;
    for (const m of rows) {
      after = m.id;
      if (!m.record_enc) { out.skipped++; continue; }
      let rec: RegisterRecord;
      try { rec = await ctx.keys.decrypt<RegisterRecord>(m.id, m.record_enc); } catch (e) { if (e instanceof ErasedError) { out.skipped++; continue; } throw e; }
      const idHash = rec.national_id ? ctx.keys.lookupHash("id", rec.national_id) : m.id_hash;
      const phoneHash = rec.phone && m.phone_hash ? ctx.keys.lookupHash("phone", rec.phone) : m.phone_hash;
      if (idHash === m.id_hash && phoneHash === m.phone_hash) { out.alreadyCurrent++; continue; }
      const done = await ctx.db.query(
        "UPDATE members SET id_hash=$2, phone_hash=$3 WHERE id=$1 AND id_hash IS NOT DISTINCT FROM $4 AND phone_hash IS NOT DISTINCT FROM $5 RETURNING id",
        [m.id, idHash, phoneHash, m.id_hash, m.phone_hash]);
      if (done.length) out.rehashed++; else out.conflicts++;
    }
  }
}
