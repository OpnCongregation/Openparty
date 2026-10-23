import { randomBytes, randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import type { Db } from "./db.js";
import type { IdResult } from "./adapters.js";
import { logRef } from "./context.js";
import { checkPin, hashPin } from "./crypto.js";
import { fail } from "./errors.js";
import { t } from "./i18n.js";

/** What a register record holds: the fields the law pack requires (register.fields), plus the phone for SMS. */
export type RegisterRecord = Record<string, string> & { phone?: string };

export function missingRegisterFields(r: Partial<RegisterRecord>, fields: readonly string[]): string[] {
  return fields.filter((f) => r[f] === undefined || r[f] === null || String(r[f]).trim() === "");
}

const registerFields = (ctx: Ctx) => ctx.config.get<string[]>("register.fields");

const PIN_RE = /^\d{4}$/;
const PENDING_TTL_MS = 10 * 60_000;

const newCardNo = () => "OP-" + randomBytes(5).toString("hex").toUpperCase();

/** Step 1 of joining: check the national ID once and hold the result briefly for confirmation. */
export async function prepareJoin(ctx: Ctx, phone: string, subjectId: string) {
  if (ctx.idAdapter.assurance < ctx.config.get<number>("identity.min_assurance_join"))
    return fail("id_assurance_low", "This identity check is too weak to join under the current law pack", 422);
  const result = await ctx.idAdapter.verify(subjectId);
  if (!result) return fail("id_invalid", "ID could not be verified");
  if (!result.ageOk) return fail("under_age", "Below the voting age set by the law pack", 422);
  const existing = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id_hash = ANY($1)", [ctx.keys.lookupCandidates("id", subjectId)]);
  if (existing.length && existing[0].state !== "resigned") return fail("id_in_use", "This ID already has a membership", 409);
  const phoneHash = ctx.keys.lookupHash("phone", phone);
  const now = ctx.clock();
  await ctx.db.query("DELETE FROM pending_joins WHERE expires_at < $1", [now.toISOString()]); // tidy up expired ones
  await ctx.db.query(
    `INSERT INTO pending_joins(phone_hash,enc,expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (phone_hash) DO UPDATE SET enc=EXCLUDED.enc, expires_at=EXCLUDED.expires_at`,
    [phoneHash, await ctx.keys.sealTemp({ subjectId, result }, `pending:${phoneHash}`), new Date(now.getTime() + PENDING_TTL_MS).toISOString()]);
  return { preview: result.preview };
}

/** Step 2: create the provisional member. One id, one member is enforced by a UNIQUE constraint. */
export async function confirmJoin(ctx: Ctx, phone: string, visibility: "visible" | "anonymous", pin: string) {
  const phoneHash = ctx.keys.lookupHash("phone", phone);
  const row = await ctx.db.query<{ enc: string; expires_at: Date }>("SELECT enc, expires_at FROM pending_joins WHERE phone_hash=$1", [phoneHash]);
  if (!row.length || new Date(row[0].expires_at).getTime() < ctx.clock().getTime()) return fail("join_expired", "Start again", 410);
  if (!PIN_RE.test(pin)) return fail("pin_format", "PIN must be 4 digits");
  const p = await ctx.keys.openTemp<{ subjectId: string; result: IdResult }>(row[0].enc, `pending:${phoneHash}`);
  const idHash = ctx.keys.lookupHash("id", p.subjectId);
  const pinHash = await hashPin(pin); // before the transaction: do not hold database locks while scrypt runs
  const joined = (tx: Db, id: string) => ctx.events.emit(tx, { type: "member.joined", data: { member_ref: logRef(ctx, "member", id) } });
  const result = await ctx.commit(async (tx) => {
    // Take the pending join: whichever request deletes the row owns it, so two simultaneous confirmations cannot both proceed.
    const taken = await tx.query("DELETE FROM pending_joins WHERE phone_hash=$1 RETURNING 1", [phoneHash]);
    if (!taken.length) return fail("join_expired", "Start again", 410);
    const prior = await tx.query<{ id: string; state: string }>("SELECT id,state FROM members WHERE id_hash = ANY($1)", [ctx.keys.lookupCandidates("id", p.subjectId)]);
    const record: Partial<RegisterRecord> = { ...p.result.attributes, national_id: p.subjectId, phone };
    if (prior.length) {
      // Resigned member rejoining starts again as provisional
      if (prior[0].state !== "resigned") return fail("id_in_use", "This ID already has a membership", 409);
      const id = prior[0].id;
      await tx.query(
        `UPDATE members SET state='provisional', pin_hash=$2, pin_failures=0, visibility=$3, phone_hash=$4,
         record_enc=$5, id_hash=$6, activated_at=NULL, activated_by=NULL, ward=NULL WHERE id=$1`,
        [id, pinHash, visibility, phoneHash, await ctx.keys.encrypt(id, record, tx), idHash],
      );
      await tx.query("DELETE FROM pin_attempts WHERE member_id=$1", [id]); // a fresh PIN starts with a clean record
      const card = (await tx.query<{ card_no: string }>("SELECT card_no FROM members WHERE id=$1", [id]))[0].card_no;
      await joined(tx, id);
      return { id, card };
    }
    const id = randomUUID();
    const card = newCardNo();
    await ctx.keys.createKey(id, tx);
    await tx.query(
      `INSERT INTO members(id,id_hash,phone_hash,state,card_no,pin_hash,visibility,record_enc)
       VALUES ($1,$2,$3,'provisional',$4,$5,$6,$7)`,
      [id, idHash, phoneHash, card, pinHash, visibility, await ctx.keys.encrypt(id, record, tx)],
    );
    await joined(tx, id);
    return { id, card };
  });

  await ctx.sms.send(phone, t(ctx, "sms.welcome", result.card));
  return { memberId: result.id, cardNo: result.card };
}

export interface ActivationInput {
  memberId: string;
  ward: string;
  pollingUnit: string;
  photoRef: string;
  disabilityStatus: string;
}

/** A ward agent confirms a member in person. The action is logged against the agent's own ID. */
export async function activateMember(ctx: Ctx, agent: { id: string; role: string; ward: string | null }, input: ActivationInput) {
  if (agent.role !== "ward_agent") return fail("forbidden", "Only ward agents can activate members", 403);
  if (agent.ward !== input.ward) return fail("wrong_ward", "Agent can only activate members in their own ward", 403);

  const rows = await ctx.db.query<{ state: string; card_no: string | null; record_enc: string }>(
    "SELECT state, card_no, record_enc FROM members WHERE id=$1", [input.memberId]);
  if (!rows.length) return fail("not_found", "No such member", 404);
  const m = rows[0];
  if (m.state !== "provisional") return fail("bad_state", `Member is ${m.state}, not provisional`, 409);
  if (!m.card_no) return fail("no_card", "Card number missing", 500);

  const rec = await ctx.keys.decrypt<RegisterRecord>(input.memberId, m.record_enc);
  Object.assign(rec, { ward: input.ward, polling_unit: input.pollingUnit, photo: input.photoRef, disability_status: input.disabilityStatus });
  const missing = missingRegisterFields(rec, registerFields(ctx));
  if (missing.length) return fail("incomplete_record", `Missing register fields: ${missing.join(", ")}`);

  const enc = await ctx.keys.encrypt(input.memberId, rec);
  await ctx.commit(async (tx) => {
    await tx.query(
      "UPDATE members SET state='active', ward=$2, record_enc=$3, activated_at=$4, activated_by=$5 WHERE id=$1",
      [input.memberId, input.ward, enc, ctx.clock().toISOString(), agent.id],
    );
    await ctx.events.emit(tx, {
      type: "member.activated",
      data: { member_ref: logRef(ctx, "member", input.memberId), agent_id: agent.id, ward: input.ward },
    });
  });
  if (rec.phone) await ctx.sms.send(rec.phone, t(ctx, "sms.active"));
}

// PIN guessing policy. A PIN is only 4 digits, so the limit on guesses IS the protection. Every guess is recorded before it is
// compared and a successful login removes only its own record, so nothing a legitimate user does can erase an attacker's failures.
//   - 5 failed guesses within any rolling 24 hours: locked until the oldest of them is 24 hours old, or a ward agent unlocks.
//   - 10 failed guesses within any rolling 30 days: locked until a ward agent unlocks (no waiting it out).
// A locked PIN refuses even the correct PIN, because accepting it would tell a guesser they were right.
export const PIN_POLICY = { windowMs: 24 * 3_600_000, maxInWindow: 5, hardWindowMs: 30 * 24 * 3_600_000, hardMax: 10 } as const;

export async function verifyPin(ctx: Ctx, phone: string, pin: string) {
  const rows = await ctx.db.query<{ id: string; state: string; pin_hash: string; card_no: string }>(
    "SELECT id,state,pin_hash,card_no FROM members WHERE phone_hash = ANY($1) AND state IN ('provisional','active')",
    [ctx.keys.lookupCandidates("phone", phone)],
  );
  if (!rows.length) return fail("no_member", "No membership for this phone", 404);
  const m = rows[0];
  const now = ctx.clock();
  // Take an attempt slot BEFORE comparing, under a per-member lock, so parallel guesses cannot all pass a stale "failures < 5" check.
  const slot = await ctx.db.tx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pin:${m.id}`]);
    await tx.query("DELETE FROM pin_attempts WHERE member_id=$1 AND at < $2", [m.id, new Date(now.getTime() - PIN_POLICY.hardWindowMs).toISOString()]);
    const day = (await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pin_attempts WHERE member_id=$1 AND at > $2", [m.id, new Date(now.getTime() - PIN_POLICY.windowMs).toISOString()]))[0].n;
    const month = (await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pin_attempts WHERE member_id=$1", [m.id]))[0].n;
    if (month >= PIN_POLICY.hardMax) return { locked: "hard" as const };
    if (day >= PIN_POLICY.maxInWindow) return { locked: "window" as const };
    const r = await tx.query<{ id: number }>("INSERT INTO pin_attempts(member_id, at) VALUES ($1,$2) RETURNING id::int AS id", [m.id, now.toISOString()]);
    return { id: r[0].id };
  });
  if ("locked" in slot) {
    return fail("pin_locked", slot.locked === "hard" ? "PIN locked; see your ward agent" : "Too many wrong PINs. Try again tomorrow, or see your ward agent", 423);
  }
  if (!(await checkPin(pin, m.pin_hash))) return fail("pin_wrong", "Wrong PIN", 401);
  await ctx.db.query("DELETE FROM pin_attempts WHERE id=$1", [slot.id]); // only this attempt: earlier failures stay on the record
  return { id: m.id, state: m.state, cardNo: m.card_no };
}

/**
 * A ward agent clears a locked PIN after meeting the member in person. This is the way out of a lock: without it a locked member
 * would stay locked for good. The unlock is public (pseudonymous) and the agent's access is logged like every agent action.
 */
export async function unlockPin(ctx: Ctx, agent: { id: string; role: string; ward: string | null }, memberId: string) {
  if (agent.role !== "ward_agent") return fail("forbidden", "Only ward agents can unlock a PIN", 403);
  const rows = await ctx.db.query<{ state: string; ward: string | null }>("SELECT state, ward FROM members WHERE id=$1", [memberId]);
  if (!rows.length) return fail("not_found", "No such member", 404);
  const m = rows[0];
  if (!["provisional", "active"].includes(m.state)) return fail("bad_state", `Member is ${m.state}`, 409);
  // A member who has been activated belongs to one ward; a provisional member has none yet, and any agent may meet them.
  if (m.ward && m.ward !== agent.ward) return fail("wrong_ward", "Agent can only unlock members in their own ward", 403);
  await ctx.commit(async (tx) => {
    await tx.query("DELETE FROM pin_attempts WHERE member_id=$1", [memberId]);
    await ctx.events.emit(tx, { type: "member.pin_unlocked", data: { member_ref: logRef(ctx, "member", memberId), agent_id: agent.id } });
  });
}
export async function resign(ctx: Ctx, memberId: string) {
  await ctx.commit(async (tx) => {
    const r = await tx.query("UPDATE members SET state='resigned' WHERE id=$1 AND state IN ('provisional','active','suspended') RETURNING id", [memberId]);
    if (!r.length) return fail("bad_state", "Cannot resign", 409);
    await ctx.events.emit(tx, { type: "member.resigned", data: { member_ref: logRef(ctx, "member", memberId) } });
  });
}

/**
 * Right to erasure by crypto-shredding: destroy the member's key. The row and log entries stay,
 * but the record can never be read again. Blocked while the member is on the register of a live contest.
 */
export async function erase(ctx: Ctx, memberId: string) {
  const live = await ctx.db.query(
    `SELECT 1 FROM register_members rm JOIN registers r ON r.id=rm.register_id JOIN contests c ON c.id=r.contest_id
     WHERE rm.member_id=$1 AND c.state <> 'closed' LIMIT 1`, [memberId]);
  if (live.length) return fail("legal_hold", "Member is on a live contest register; erasure must wait", 409);
  await ctx.commit(async (tx) => {
    await ctx.keys.shred(memberId, tx);
    await tx.query(
      "UPDATE members SET state='erased', pin_hash=NULL, phone_hash=NULL, id_hash='erased:'||id WHERE id=$1", [memberId]);
    await ctx.events.emit(tx, { type: "member.erased", data: { member_ref: logRef(ctx, "member", memberId) } });
  });
}
