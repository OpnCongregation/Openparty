import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { DAY, logRef } from "./context.js";
import { canonical, sha256hex } from "./crypto.js";
import { fail } from "./errors.js";
import { missingRegisterFields, type RegisterRecord } from "./members.js";
import { checkSetting, EDITABLE_KEYS } from "./framework/resolve.js";

// ---- Rules ------------------------------------------------------------------------------------

/**
 * The party's editable rules. Only these keys can be changed while the party runs, and only with the
 * approvals in admin.ts. There is deliberately no key that could add a qualification or disqualification
 * criterion for aspirants (the law pack switches that feature off). Every value is also checked against the
 * country law pack: a party may tighten the law, never loosen it.
 */
const isEditable = (key: string): key is (typeof EDITABLE_KEYS)[number] => (EDITABLE_KEYS as readonly string[]).includes(key);

export async function getRule<T = unknown>(ctx: Ctx, key: string): Promise<T> {
  if (!isEditable(key)) return fail("unknown_rule", `Unknown rule: ${key}`);
  const r = await ctx.db.query<{ value: string }>("SELECT value FROM rules WHERE key=$1 ORDER BY version DESC LIMIT 1", [key]);
  return (r.length ? JSON.parse(r[0].value) : ctx.config.get(key)) as T;
}

/** Fingerprint of everything a contest notice commits to: the editable rules and the three layers. */
export async function rulesHash(ctx: Ctx): Promise<string> {
  const all: Record<string, unknown> = { layers: ctx.config.fingerprint };
  for (const k of EDITABLE_KEYS) all[k] = await getRule(ctx, k);
  return sha256hex(canonical(all));
}

/** Rules freeze the moment any contest has a notice out, and stay frozen until it closes. */
export async function setRule(ctx: Ctx, key: string, value: unknown, adminId: string) {
  if (!isEditable(key)) return fail("unknown_rule", `Unknown rule: ${key}`);
  const problems = checkSetting(ctx.config.pack, key, value as any);
  if (problems.length) return fail("invalid_rule", `Invalid value for ${key}: ${problems.map((p) => p.message).join("; ")}`, 422);
  const locked = await ctx.db.query("SELECT 1 FROM contests WHERE state IN ('noticed','open') LIMIT 1");
  if (locked.length) return fail("rules_locked", "Rules are locked: a contest notice is out", 423);
  const v = (await ctx.db.query<{ v: number }>("SELECT COALESCE(MAX(version),0)+1 AS v FROM rules WHERE key=$1", [key]))[0].v;
  await ctx.db.query("INSERT INTO rules(key,version,value,set_by) VALUES ($1,$2,$3,$4)", [key, v, JSON.stringify(value), adminId]);
  await ctx.log.append({ type: "rule.set", data: { key, version: v, value_hash: sha256hex(canonical(value)), set_by: adminId } });
}

// ---- Contests ---------------------------------------------------------------------------------

export interface Contest {
  id: string; name: string; primary_type: string; mode: string | null;
  vote_date: Date; state: "draft" | "noticed" | "open" | "closed"; register_id: string | null;
  notice_at: Date | null; notice_receipt: string | null; rules_hash: string | null;
}

async function getContest(ctx: Ctx, id: string): Promise<Contest> {
  const r = await ctx.db.query<Contest>("SELECT * FROM contests WHERE id=$1", [id]);
  return r.length ? r[0] : fail("not_found", "No such contest", 404);
}

export async function createContest(
  ctx: Ctx,
  input: { name: string; primaryType: string; mode: string; voteDate: Date },
) {
  // The notice must state the mode (Reg 10(2) in the Nigeria pack), so a contest cannot exist without one.
  const modes = ctx.config.get<string[]>("notice.modes");
  if (ctx.config.get<boolean>("notice.mode_required") && !input.mode) return fail("mode_required", "Contest mode is required");
  if (input.mode && !modes.includes(input.mode)) return fail("bad_mode", `Mode must be one of: ${modes.join(", ")}`);
  if (!ctx.config.get<string[]>("primary.allowed_types").includes(input.primaryType))
    return fail("bad_primary_type", `Primary type must be one of: ${ctx.config.get<string[]>("primary.allowed_types").join(", ")}`);
  const id = randomUUID();
  await ctx.db.query("INSERT INTO contests(id,name,primary_type,mode,vote_date) VALUES ($1,$2,$3,$4,$5)",
    [id, input.name, input.primaryType, input.mode, input.voteDate.toISOString()]);
  await ctx.log.append({ type: "contest.created", data: { contest_id: id, mode: input.mode, vote_date: input.voteDate.toISOString() } });
  return id;
}

/** The primary type cannot change inside the lock window before the vote (Reg 24(3) in the Nigeria pack). */
export async function changePrimaryType(ctx: Ctx, contestId: string, type: string) {
  const c = await getContest(ctx, contestId);
  const lockDays = ctx.config.get<number>("primary.type_lock_days");
  if (!ctx.config.get<string[]>("primary.allowed_types").includes(type)) return fail("bad_primary_type", "That primary type is not allowed");
  if (new Date(c.vote_date).getTime() - ctx.clock().getTime() <= lockDays * DAY)
    return fail("type_locked", `Primary type is locked inside ${lockDays} days of the vote`, 423);
  if (c.state === "open" || c.state === "closed") return fail("bad_state", "Contest already open or closed", 409);
  await ctx.db.query("UPDATE contests SET primary_type=$2 WHERE id=$1", [contestId, type]);
  await ctx.log.append({ type: "contest.type_changed", data: { contest_id: contestId, primary_type: type } });
}

/** The law pack sets the notice period (21 days in Nigeria). A late notice voids the contest, so the system refuses to issue one. */
export async function generateNotice(ctx: Ctx, contestId: string) {
  const c = await getContest(ctx, contestId);
  if (c.state !== "draft") return fail("bad_state", "Notice already generated", 409);
  if (!c.mode) return fail("mode_required", "Notice must state the mode of voting");
  const daysLeft = (new Date(c.vote_date).getTime() - ctx.clock().getTime()) / DAY;
  const noticeDays = ctx.config.get<number>("notice.days_before_contest");
  if (daysLeft < noticeDays) return fail("notice_late", `Only ${daysLeft.toFixed(1)} days to vote; ${noticeDays} days' notice is required`, 422);
  const hash = await rulesHash(ctx);
  await ctx.db.query("UPDATE contests SET state='noticed', notice_at=$2, rules_hash=$3 WHERE id=$1", [contestId, ctx.clock().toISOString(), hash]);
  await ctx.log.append({ type: "contest.noticed", data: { contest_id: contestId, mode: c.mode, rules_hash: hash, vote_date: new Date(c.vote_date).toISOString() } });
  return { contestId, mode: c.mode, voteDate: c.vote_date, rulesHash: hash, noticeDeadline: new Date(new Date(c.vote_date).getTime() - noticeDays * DAY) };
}

export async function recordNoticeReceipt(ctx: Ctx, contestId: string, receipt: string) {
  const c = await getContest(ctx, contestId);
  if (c.state !== "noticed") return fail("bad_state", "Generate the notice first", 409);
  if (c.notice_receipt) return fail("already_set", "Receipt already recorded", 409);
  if (!receipt.trim()) return fail("receipt_required", "Receipt reference required");
  await ctx.db.query("UPDATE contests SET notice_receipt=$2 WHERE id=$1", [contestId, receipt]);
  await ctx.log.append({ type: "contest.notice_receipt", data: { contest_id: contestId, receipt_hash: sha256hex(receipt) } });
}

// ---- Register ---------------------------------------------------------------------------------

/**
 * Freeze the register for a contest: snapshot active members, check every s.77(2) field, fingerprint it,
 * and post the fingerprint to the log. Filing must be at least register.days_before_contest days before the contest.
 */
export async function freezeRegister(ctx: Ctx, contestId: string) {
  const c = await getContest(ctx, contestId);
  if (c.register_id) return fail("already_frozen", "Register already frozen for this contest", 409);
  const regDays = ctx.config.get<number>("register.days_before_contest");
  if ((new Date(c.vote_date).getTime() - ctx.clock().getTime()) / DAY < regDays)
    return fail("register_late", `Register must be filed at least ${regDays} days before the contest`, 422);

  const members = await ctx.db.query<{ id: string; card_no: string; record_enc: string }>(
    "SELECT id, card_no, record_enc FROM members WHERE state='active' AND activated_at <= $1 ORDER BY card_no", [ctx.clock().toISOString()]);
  const rows: (RegisterRecord & { card_no: string })[] = [];
  for (const m of members) {
    const rec = await ctx.keys.decrypt<RegisterRecord>(m.id, m.record_enc);
    const missing = missingRegisterFields(rec, ctx.config.get<string[]>("register.fields"));
    if (missing.length) return fail("incomplete_record", `Member ${m.card_no} missing: ${missing.join(", ")}`, 422);
    const { phone: _phone, ...legal } = rec;
    rows.push({ card_no: m.card_no, ...legal } as any);
  }
  const exportJson = canonical({ contest_id: contestId, frozen_at: ctx.clock().toISOString(), members: rows });
  const fingerprint = sha256hex(exportJson);
  const id = randomUUID();

  await ctx.db.tx(async (tx) => {
    await ctx.keys.createKey(`register:${id}`, tx);
    await tx.query(
      "INSERT INTO registers(id,contest_id,frozen_at,fingerprint,member_count,export_json) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, contestId, ctx.clock().toISOString(), fingerprint, rows.length, await ctx.keys.encrypt(`register:${id}`, JSON.parse(exportJson), tx)]);
    for (const m of members) await tx.query("INSERT INTO register_members(register_id,member_id) VALUES ($1,$2)", [id, m.id]);
    await tx.query("UPDATE contests SET register_id=$2 WHERE id=$1", [contestId, id]);
  });
  await ctx.log.append({ type: "register.frozen", data: { contest_id: contestId, register_id: id, fingerprint, member_count: rows.length } });
  return { registerId: id, fingerprint, memberCount: rows.length };
}

/** Read-only register export for INEC. Decrypts on demand; callers must be authorised and the access logged. */
export async function exportRegister(ctx: Ctx, registerId: string) {
  const r = await ctx.db.query<{ export_json: string; fingerprint: string }>("SELECT export_json, fingerprint FROM registers WHERE id=$1", [registerId]);
  if (!r.length) return fail("not_found", "No such register", 404);
  const doc = await ctx.keys.decrypt(`register:${registerId}`, r[0].export_json);
  if (sha256hex(canonical(doc)) !== r[0].fingerprint) return fail("integrity", "Register fingerprint mismatch", 500);
  return { fingerprint: r[0].fingerprint, document: doc };
}

/** Field-by-field validator for an export, as required by the traceability matrix. */
export function validateRegisterExport(doc: { members: Partial<RegisterRecord>[] }, fields: readonly string[]): string[] {
  return doc.members.flatMap((m, i) => missingRegisterFields(m, fields).map((f) => `member ${i}: missing ${f}`));
}

export async function recordRegisterReceipt(ctx: Ctx, registerId: string, receipt: string) {
  if (!receipt.trim()) return fail("receipt_required", "Receipt reference required");
  const r = await ctx.db.query("UPDATE registers SET inec_receipt=$2 WHERE id=$1 AND inec_receipt IS NULL RETURNING id", [registerId, receipt]);
  if (!r.length) return fail("bad_state", "Unknown register or receipt already recorded", 409);
  await ctx.log.append({ type: "register.receipt", data: { register_id: registerId, receipt_hash: sha256hex(receipt) } });
}

// ---- Opening the contest ----------------------------------------------------------------------

/** Voting stays locked until every earlier legal step has a stored receipt. */
export async function openContest(ctx: Ctx, contestId: string) {
  const c = await getContest(ctx, contestId);
  if (c.state !== "noticed") return fail("not_noticed", "Contest has no notice", 409);
  if (!c.notice_receipt) return fail("no_notice_receipt", "INEC notice receipt not recorded", 423);
  if (!c.register_id) return fail("no_register", "Register not frozen", 423);
  const reg = await ctx.db.query<{ inec_receipt: string | null }>("SELECT inec_receipt FROM registers WHERE id=$1", [c.register_id]);
  if (!reg[0]?.inec_receipt) return fail("no_register_receipt", "INEC register receipt not recorded", 423);
  if (await rulesHash(ctx) !== c.rules_hash) return fail("rules_changed", "Rules differ from those in the notice", 500);
  await ctx.db.query("UPDATE contests SET state='open' WHERE id=$1", [contestId]);
  await ctx.log.append({ type: "contest.opened", data: { contest_id: contestId } });
}

export async function closeContest(ctx: Ctx, contestId: string) {
  const r = await ctx.db.query("UPDATE contests SET state='closed' WHERE id=$1 AND state='open' RETURNING id", [contestId]);
  if (!r.length) return fail("bad_state", "Contest is not open", 409);
  await ctx.log.append({ type: "contest.closed", data: { contest_id: contestId } });
}

export { logRef };
