import { createPublicKey, randomUUID, verify } from "node:crypto";
import { scopedCtx, type Ctx } from "./context.js";
import { sha256hex } from "./crypto.js";
import { fail } from "./errors.js";
import * as contests from "./contests.js";

/**
 * Roles. There is deliberately no "security" role (Electoral Act s.96(5)-(6)) and no super admin:
 * nobody holds every permission, and sensitive actions need several people.
 */
export const ROLES = ["secretary", "electoral_committee", "treasurer", "auditor", "tribunal", "ward_agent"] as const;
export type Role = (typeof ROLES)[number];

const PERMISSIONS: Record<Role, string[]> = {
  secretary: ["contest.create", "notice.generate", "receipt.record", "approval.propose", "approval.approve"],
  electoral_committee: ["contest.create", "receipt.record", "approval.propose", "approval.approve"],
  treasurer: ["gift.record", "finance.retry"],
  auditor: ["finance.report", "register.read", "access.read", "approval.approve"],
  tribunal: [],
  ward_agent: ["member.activate"],
};

export interface Admin { id: string; name: string; role: Role; ward: string | null }

export const can = (a: Admin, perm: string) => PERMISSIONS[a.role].includes(perm);
export function require_(a: Admin, perm: string) {
  if (!can(a, perm)) return fail("forbidden", `${a.role} may not ${perm}`, 403);
}

export async function registerAdmin(ctx: Ctx, input: { name: string; role: Role; ward?: string; publicKeyHex: string }) {
  if (!ROLES.includes(input.role)) return fail("bad_role", "Unknown role");
  if (input.role === "ward_agent" && !input.ward) return fail("ward_required", "Ward agents need a ward");
  const id = randomUUID();
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO admins(id,name,role,ward,public_key) VALUES ($1,$2,$3,$4,$5)",
      [id, input.name, input.role, input.ward ?? null, input.publicKeyHex]);
    await ctx.events.emit(tx, { type: "admin.registered", data: { admin_id: id, role: input.role } });
  });
  return id;
}

export const signingString = (ts: string, method: string, path: string, body: string) =>
  `${ts}\n${method.toUpperCase()}\n${path}\n${sha256hex(body)}`;

/**
 * Every admin request is signed with that person's own key (stand-in for a hardware key), so there
 * are no shared logins and no passwords. Signatures expire in 5 minutes and cannot be replayed.
 */
export async function authenticate(ctx: Ctx, h: { adminId?: string; ts?: string; sig?: string }, method: string, path: string, body: string): Promise<Admin> {
  if (!h.adminId || !h.ts || !h.sig) return fail("unauthenticated", "Signature headers required", 401);
  if (Math.abs(ctx.clock().getTime() - Number(h.ts)) > 5 * 60_000) return fail("stale", "Signature expired", 401);
  const rows = await ctx.db.query<{ id: string; name: string; role: Role; ward: string | null; public_key: string; active: boolean }>(
    "SELECT * FROM admins WHERE id=$1", [h.adminId]);
  if (!rows.length || !rows[0].active) return fail("unauthenticated", "Unknown or disabled admin", 401);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rows[0].public_key, "hex")]), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(signingString(h.ts, method, path, body)), key, Buffer.from(h.sig, "hex")))
    return fail("unauthenticated", "Bad signature", 401);
  const fresh = await ctx.db.query("INSERT INTO seen_signatures(sig) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1", [h.sig]);
  if (!fresh.length) return fail("replay", "Signature already used", 401);
  const a = rows[0];
  return { id: a.id, name: a.name, role: a.role, ward: a.ward };
}

/** Every access is written to the immutable access log and its hash is posted to the public log. */
export async function logAccess(ctx: Ctx, adminId: string, action: string, detail = "") {
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO access_log(admin_id,action,detail) VALUES ($1,$2,$3)", [adminId, action, detail]);
    await ctx.events.emit(tx, { type: "admin.access", data: { admin_id: adminId, action, detail_hash: sha256hex(detail) } });
  });
}

// ---- Multi-person approvals -------------------------------------------------------------------

interface ActionSpec {
  proposers: Role[];
  approvers: Role[];
  /** Approvals needed from distinct admins other than the proposer. */
  needed: number;
  /** Runs inside the approval's own transaction (ctx is scoped to it), so its effects commit with the 'executed' mark. */
  run: (ctx: Ctx, payload: any, proposer: string) => Promise<unknown>;
}

const ACTIONS: Record<string, ActionSpec> = {
  "rule.set": {
    proposers: ["secretary"], approvers: ["electoral_committee", "auditor"], needed: 1,
    run: (ctx, p, by) => contests.setRule(ctx, p.key, p.value, by),
  },
  "register.freeze": {
    proposers: ["secretary"], approvers: ["electoral_committee", "auditor"], needed: 2,
    run: (ctx, p) => contests.freezeRegister(ctx, p.contestId),
  },
  "contest.open": {
    proposers: ["electoral_committee"], approvers: ["secretary", "auditor"], needed: 2,
    run: (ctx, p) => contests.openContest(ctx, p.contestId),
  },
};

export const approvalActions = Object.keys(ACTIONS);

export async function propose(ctx: Ctx, admin: Admin, action: string, payload: unknown) {
  const spec = ACTIONS[action];
  if (!spec) return fail("unknown_action", `Unknown action ${action}`);
  require_(admin, "approval.propose");
  if (!spec.proposers.includes(admin.role)) return fail("forbidden", `${admin.role} cannot propose ${action}`, 403);
  const id = randomUUID();
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO approvals(id,action,payload,proposer) VALUES ($1,$2,$3,$4)", [id, action, JSON.stringify(payload), admin.id]);
    await ctx.events.emit(tx, { type: "approval.proposed", data: { approval_id: id, action, proposer: admin.id } });
  });
  return id;
}

export async function approve(ctx: Ctx, admin: Admin, approvalId: string) {
  require_(admin, "approval.approve");
  // Vote, count and claim in one transaction under a row lock, so two simultaneous requests cannot both reach the
  // threshold and both run the action: exactly one caller wins the 'pending' -> 'executing' transition and gets the token.
  const token = randomUUID();
  const step = await ctx.commit(async (tx) => {
    const rows = await tx.query<{ action: string; payload: string; proposer: string; status: string }>("SELECT * FROM approvals WHERE id=$1 FOR UPDATE", [approvalId]);
    if (!rows.length) return fail("not_found", "No such approval", 404);
    const a = rows[0];
    const spec = ACTIONS[a.action];
    if (a.status !== "pending") return fail("bad_state", `Approval is ${a.status}`, 409);
    if (admin.id === a.proposer) return fail("self_approval", "You cannot approve your own proposal", 403);
    if (!spec.approvers.includes(admin.role)) return fail("forbidden", `${admin.role} cannot approve ${a.action}`, 403);
    await tx.query("INSERT INTO approval_votes(approval_id,admin_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [approvalId, admin.id]);
    const n = (await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM approval_votes WHERE approval_id=$1", [approvalId]))[0].n;
    const claimed = n >= spec.needed
      && (await tx.query(
        "UPDATE approvals SET status='executing', claim_token=$2, claimed_at=$3, attempts=attempts+1 WHERE id=$1 AND status='pending' RETURNING id",
        [approvalId, token, new Date().toISOString()])).length === 1;
    await ctx.events.emit(tx, { type: "approval.voted", data: { approval_id: approvalId, admin_id: admin.id, votes: n } });
    return { a, spec, n, claimed };
  });
  const { a, spec, n, claimed } = step;
  if (!claimed) return { executed: false, votes: n, needed: spec.needed };
  await ctx.crashAt?.("after_claim");
  const run = await runClaimed(ctx, { id: approvalId, action: a.action, payload: a.payload, proposer: a.proposer }, token);
  return { ...run, votes: n, needed: spec.needed };
}

/**
 * Apply a claimed approval. The action's effects, the 'executed' mark, its result and its public event all commit in ONE
 * transaction, so 'executing' can only ever mean "not applied yet": a crash at any point either leaves nothing applied
 * (the lease later expires and recoverApprovals retries) or everything applied. The claim token is checked inside that same
 * transaction, so a claimant that was slow, not dead, cannot apply the action a second time after someone else took over.
 */
async function runClaimed(ctx: Ctx, a: { id: string; action: string; payload: string; proposer: string }, token: string): Promise<{ executed: boolean; result?: unknown }> {
  const spec = ACTIONS[a.action];
  try {
    const result = await ctx.commit(async (tx) => {
      const cur = await tx.query<{ status: string; claim_token: string | null }>("SELECT status, claim_token FROM approvals WHERE id=$1 FOR UPDATE", [a.id]);
      if (!cur.length || cur[0].status !== "executing" || cur[0].claim_token !== token) throw new LostClaim();
      await ctx.crashAt?.("before_effect");
      const r = await spec.run(scopedCtx(ctx, tx), JSON.parse(a.payload), a.proposer);
      await ctx.crashAt?.("after_effect");
      await tx.query("UPDATE approvals SET status='executed', result=$2, executed_at=$3 WHERE id=$1", [a.id, JSON.stringify(r ?? null), new Date().toISOString()]);
      await ctx.events.emit(tx, { type: "approval.executed", data: { approval_id: a.id, action: a.action } });
      return r;
    });
    await ctx.crashAt?.("after_commit");
    return { executed: true, result };
  } catch (e: any) {
    if (e instanceof LostClaim) return { executed: false };
    if (e instanceof CrashPoint) throw e; // a simulated crash must not be recorded as a failure
    // The action itself refused (a rule changed since the proposal, for example). Nothing was applied: record why.
    await ctx.db.query("UPDATE approvals SET status='failed', result=$2 WHERE id=$1 AND claim_token=$3 AND status='executing'", [a.id, String(e.message), token]);
    throw e;
  }
}

class LostClaim extends Error { constructor() { super("approval claim was taken over"); } }
/** Thrown by a test's crashAt hook to simulate the process dying at that point. */
export class CrashPoint extends Error { constructor(readonly point: string) { super(`simulated crash at ${point}`); } }

const MAX_EXECUTION_ATTEMPTS = 3;

/**
 * Finish approvals whose executor died: re-claim any 'executing' approval whose lease has expired and apply it. Safe to run on
 * every instance at once (the claim is an atomic update), at startup and on a timer. After three failed attempts the approval is
 * marked failed so it cannot loop forever.
 */
export async function recoverApprovals(ctx: Ctx, leaseSeconds = 60): Promise<{ recovered: number; failed: number }> {
  const cutoff = new Date(Date.now() - leaseSeconds * 1000).toISOString();
  const stale = await ctx.db.query<{ id: string }>("SELECT id FROM approvals WHERE status='executing' AND (claimed_at IS NULL OR claimed_at <= $1) ORDER BY created_at", [cutoff]);
  let recovered = 0, failed = 0;
  for (const s of stale) {
    const token = randomUUID();
    const got = await ctx.db.query<{ id: string; action: string; payload: string; proposer: string; attempts: number }>(
      `UPDATE approvals SET claim_token=$2, claimed_at=$3, attempts=attempts+1
       WHERE id=$1 AND status='executing' AND (claimed_at IS NULL OR claimed_at <= $4) RETURNING id, action, payload, proposer, attempts`,
      [s.id, token, new Date().toISOString(), cutoff]);
    if (!got.length) continue; // someone else got there first
    if (got[0].attempts > MAX_EXECUTION_ATTEMPTS) {
      await ctx.db.query("UPDATE approvals SET status='failed', result=$2 WHERE id=$1 AND claim_token=$3", [s.id, `gave up after ${MAX_EXECUTION_ATTEMPTS} attempts`, token]);
      failed++;
      continue;
    }
    try {
      const r = await runClaimed(ctx, got[0], token);
      if (r.executed) recovered++;
    } catch (e) {
      if (e instanceof CrashPoint) throw e;
      failed++; // runClaimed already recorded the refusal
    }
  }
  return { recovered, failed };
}