import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { DAY, logRef } from "./context.js";
import { getRule } from "./contests.js";
import { fail } from "./errors.js";

export async function createProposal(ctx: Ctx, memberId: string, title: string, body: string, threshold?: number) {
  const m = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [memberId]);
  if (!m.length || !["provisional", "active"].includes(m[0].state)) return fail("not_member", "Only members can propose", 403);
  if (!title.trim() || !body.trim()) return fail("empty", "Title and body are required");
  const t = threshold ?? (await getRule<number>(ctx, "proposals.threshold"));
  const id = randomUUID();
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO proposals(id,author_id,title,body,threshold) VALUES ($1,$2,$3,$4,$5)", [id, memberId, title, body, t]);
    await ctx.events.emit(tx, { type: "proposal.created", data: { proposal_id: id, threshold: t, author_ref: logRef(ctx, "member", memberId) } });
  });
  return id;
}

/**
 * Provisional members can sign (they cannot vote). One signature per member. When the threshold is
 * reached the proposal is queued with a response deadline: it must be formally considered.
 */
export async function signProposal(ctx: Ctx, memberId: string, proposalId: string) {
  const m = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [memberId]);
  if (!m.length || !["provisional", "active"].includes(m[0].state)) return fail("not_member", "Only members can sign", 403);

  // Read config before opening the transaction: queries on ctx.db inside it would use another connection.
  const days = await getRule<number>(ctx, "proposals.response_days");
  return ctx.commit(async (tx) => {
    const p = await tx.query<{ threshold: number; status: string }>("SELECT threshold,status FROM proposals WHERE id=$1", [proposalId]);
    if (!p.length) return fail("not_found", "No such proposal", 404);
    const dup = await tx.query("INSERT INTO signatures(proposal_id,member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1", [proposalId, memberId]);
    if (!dup.length) return fail("already_signed", "You already signed this proposal", 409);
    const count = (await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM signatures WHERE proposal_id=$1", [proposalId]))[0].n;
    let queued = false;
    if (count >= p[0].threshold && p[0].status === "open") {
      await tx.query("UPDATE proposals SET status='under_consideration' WHERE id=$1", [proposalId]);
      await tx.query("INSERT INTO agenda(proposal_id,respond_by) VALUES ($1,$2)", [proposalId, new Date(ctx.clock().getTime() + days * DAY).toISOString()]);
      queued = true;
    }
    if (queued) await ctx.events.emit(tx, { type: "proposal.threshold_reached", data: { proposal_id: proposalId, signatures: count } });
    return { signatures: count, queued };
  });
}

/** Public view: counts only. Signer identities are never exposed. */
export async function proposalStatus(ctx: Ctx, proposalId: string) {
  const r = await ctx.db.query<{ id: string; title: string; threshold: number; status: string; signatures: number }>(
    `SELECT p.id, p.title, p.threshold, p.status, (SELECT COUNT(*)::int FROM signatures s WHERE s.proposal_id=p.id) AS signatures
     FROM proposals p WHERE p.id=$1`, [proposalId]);
  return r.length ? r[0] : fail("not_found", "No such proposal", 404);
}
