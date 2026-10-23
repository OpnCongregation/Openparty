import type { Ctx } from "./context.js";
import { logRef } from "./context.js";

/** Pseudonyms of every member the public log says was erased. */
export function erasedRefsFromEntries(entries: Buffer[]): Set<string> {
  const refs = new Set<string>();
  for (const b of entries) {
    try {
      const e = JSON.parse(b.toString("utf8"));
      if (e?.type === "member.erased" && typeof e.data?.member_ref === "string") refs.add(e.data.member_ref);
    } catch { /* not an event we can read */ }
  }
  return refs;
}

/**
 * After restoring a database backup, erasures made since the backup was taken are back from the dead: the wrapped key row was
 * restored with the rest. The public log still records every erasure (as a pseudonym), so this re-applies them: it finds each
 * member whose pseudonym appears in a `member.erased` entry and destroys their key again. Safe to run repeatedly. Run it BEFORE the
 * restored platform serves any traffic. Writes no new log entry: the erasure is already public.
 */
export async function replayErasures(ctx: Ctx, refs: Set<string>): Promise<{ replayed: number; checked: number }> {
  const members = await ctx.db.query<{ id: string }>("SELECT id FROM members WHERE state <> 'erased'");
  let replayed = 0;
  for (const m of members) {
    if (!refs.has(logRef(ctx, "member", m.id))) continue;
    await ctx.db.tx(async (tx) => {
      await ctx.keys.shred(m.id, tx);
      await tx.query("UPDATE members SET state='erased', pin_hash=NULL, phone_hash=NULL, id_hash='erased:'||id WHERE id=$1", [m.id]);
    });
    replayed++;
  }
  return { replayed, checked: members.length };
}
