import { randomBytes, randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
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
const MAX_PIN_FAILURES = 5;
const PENDING_TTL_MS = 10 * 60_000;

const newCardNo = () => "OP-" + randomBytes(5).toString("hex").toUpperCase();

/** Step 1 of joining: check the national ID once and hold the result briefly for confirmation. */
export async function prepareJoin(ctx: Ctx, phone: string, subjectId: string) {
  if (ctx.idAdapter.assurance < ctx.config.get<number>("identity.min_assurance_join"))
    return fail("id_assurance_low", "This identity check is too weak to join under the current law pack", 422);
  const result = await ctx.idAdapter.verify(subjectId);
  if (!result) return fail("id_invalid", "ID could not be verified");
  if (!result.ageOk) return fail("under_age", "Below the voting age set by the law pack", 422);
  const existing = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id_hash=$1", [ctx.keys.lookupHash("id", subjectId)]);
  if (existing.length && existing[0].state !== "resigned") return fail("id_in_use", "This ID already has a membership", 409);
  ctx.pending.set(phone, { subjectId, result, expires: ctx.clock().getTime() + PENDING_TTL_MS });
  return { preview: result.preview };
}

/** Step 2: create the provisional member. One id, one member is enforced by a UNIQUE constraint. */
export async function confirmJoin(ctx: Ctx, phone: string, visibility: "visible" | "anonymous", pin: string) {
  const p = ctx.pending.get(phone);
  if (!p || p.expires < ctx.clock().getTime()) return fail("join_expired", "Start again", 410);
  if (!PIN_RE.test(pin)) return fail("pin_format", "PIN must be 4 digits");
  const idHash = ctx.keys.lookupHash("id", p.subjectId);
  const phoneHash = ctx.keys.lookupHash("phone", phone);

  const result = await ctx.db.tx(async (tx) => {
    const prior = await tx.query<{ id: string; state: string }>("SELECT id,state FROM members WHERE id_hash=$1", [idHash]);
    const record: Partial<RegisterRecord> = { ...p.result.attributes, national_id: p.subjectId, phone };
    if (prior.length) {
      // Resigned member rejoining starts again as provisional
      if (prior[0].state !== "resigned") return fail("id_in_use", "This ID already has a membership", 409);
      const id = prior[0].id;
      await tx.query(
        `UPDATE members SET state='provisional', pin_hash=$2, pin_failures=0, visibility=$3, phone_hash=$4,
         record_enc=$5, activated_at=NULL, activated_by=NULL, ward=NULL WHERE id=$1`,
        [id, hashPin(pin), visibility, phoneHash, await ctx.keys.encrypt(id, record, tx)],
      );
      const card = (await tx.query<{ card_no: string }>("SELECT card_no FROM members WHERE id=$1", [id]))[0].card_no;
      return { id, card };
    }
    const id = randomUUID();
    const card = newCardNo();
    await ctx.keys.createKey(id, tx);
    await tx.query(
      `INSERT INTO members(id,id_hash,phone_hash,state,card_no,pin_hash,visibility,record_enc)
       VALUES ($1,$2,$3,'provisional',$4,$5,$6,$7)`,
      [id, idHash, phoneHash, card, hashPin(pin), visibility, await ctx.keys.encrypt(id, record, tx)],
    );
    return { id, card };
  });

  ctx.pending.delete(phone);
  await ctx.log.append({ type: "member.joined", data: { member_ref: logRef(ctx, "member", result.id) } });
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

  await ctx.db.query(
    "UPDATE members SET state='active', ward=$2, record_enc=$3, activated_at=$4, activated_by=$5 WHERE id=$1",
    [input.memberId, input.ward, await ctx.keys.encrypt(input.memberId, rec), ctx.clock().toISOString(), agent.id],
  );
  await ctx.log.append({
    type: "member.activated",
    data: { member_ref: logRef(ctx, "member", input.memberId), agent_id: agent.id, ward: input.ward },
  });
  if (rec.phone) await ctx.sms.send(rec.phone, t(ctx, "sms.active"));
}

/** PIN check with lockout; PINs are only 4 digits, so the attempt counter is the real protection. */
export async function verifyPin(ctx: Ctx, phone: string, pin: string) {
  const rows = await ctx.db.query<{ id: string; state: string; pin_hash: string; card_no: string }>(
    "SELECT id,state,pin_hash,card_no FROM members WHERE phone_hash=$1 AND state IN ('provisional','active')",
    [ctx.keys.lookupHash("phone", phone)],
  );
  if (!rows.length) return fail("no_member", "No membership for this phone", 404);
  const m = rows[0];
  // Take an attempt slot atomically BEFORE comparing, so parallel guesses cannot all pass a stale "failures < 5" check.
  const slot = await ctx.db.query("UPDATE members SET pin_failures=pin_failures+1 WHERE id=$1 AND pin_failures < $2 RETURNING id", [m.id, MAX_PIN_FAILURES]);
  if (!slot.length) return fail("pin_locked", "PIN locked; see your ward agent", 423);
  if (!checkPin(pin, m.pin_hash)) return fail("pin_wrong", "Wrong PIN", 401);
  await ctx.db.query("UPDATE members SET pin_failures=0 WHERE id=$1", [m.id]);
  return { id: m.id, state: m.state, cardNo: m.card_no };
}

export async function resign(ctx: Ctx, memberId: string) {
  const r = await ctx.db.query("UPDATE members SET state='resigned' WHERE id=$1 AND state IN ('provisional','active','suspended') RETURNING id", [memberId]);
  if (!r.length) return fail("bad_state", "Cannot resign", 409);
  await ctx.log.append({ type: "member.resigned", data: { member_ref: logRef(ctx, "member", memberId) } });
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
  await ctx.db.tx(async (tx) => {
    await ctx.keys.shred(memberId, tx);
    await tx.query(
      "UPDATE members SET state='erased', pin_hash=NULL, phone_hash=NULL, id_hash='erased:'||id WHERE id=$1", [memberId]);
  });
  await ctx.log.append({ type: "member.erased", data: { member_ref: logRef(ctx, "member", memberId) } });
}
