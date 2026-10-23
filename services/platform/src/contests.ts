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
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO rules(key,version,value,set_by) VALUES ($1,$2,$3,$4)", [key, v, JSON.stringify(value), adminId]);
    await ctx.events.emit(tx, { type: "rule.set", data: { key, version: v, value_hash: sha256hex(canonical(value)), set_by: adminId } });
  });
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

/** INEC receipt references: 6 to 64 characters of letters, digits and . _ / -. Free text such as "x" is refused. The platform cannot check a receipt with INEC; it can only refuse nonsense. */
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._/-]{5,63}$/;
const badReceipt = (receipt: string) => !RECEIPT.test((receipt ?? "").trim());
const RECEIPT_MSG = "Receipt reference must be 6 to 64 characters: letters, digits and . _ / -";

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
  const clash = await ctx.db.query(
    "SELECT 1 FROM contests WHERE state<>'closed' AND (vote_date AT TIME ZONE 'UTC')::date = ($1::timestamptz AT TIME ZONE 'UTC')::date", [input.voteDate.toISOString()]);
  if (clash.length) return fail("contest_overlap", "Another contest that is not closed already has this vote date", 409);
  const id = randomUUID();
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO contests(id,name,primary_type,mode,vote_date) VALUES ($1,$2,$3,$4,$5)",
      [id, input.name, input.primaryType, input.mode, input.voteDate.toISOString()]);
    await ctx.events.emit(tx, { type: "contest.created", data: { contest_id: id, mode: input.mode, vote_date: input.voteDate.toISOString() } });
  });
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
  await ctx.commit(async (tx) => {
    await tx.query("UPDATE contests SET primary_type=$2 WHERE id=$1", [contestId, type]);
    await ctx.events.emit(tx, { type: "contest.type_changed", data: { contest_id: contestId, primary_type: type } });
  });
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
  await ctx.commit(async (tx) => {
    await tx.query("UPDATE contests SET state='noticed', notice_at=$2, rules_hash=$3 WHERE id=$1", [contestId, ctx.clock().toISOString(), hash]);
    await ctx.events.emit(tx, { type: "contest.noticed", data: { contest_id: contestId, mode: c.mode, rules_hash: hash, vote_date: new Date(c.vote_date).toISOString() } });
  });
  return { contestId, mode: c.mode, voteDate: c.vote_date, rulesHash: hash, noticeDeadline: new Date(new Date(c.vote_date).getTime() - noticeDays * DAY) };
}

export async function recordNoticeReceipt(ctx: Ctx, contestId: string, receipt: string) {
  const c = await getContest(ctx, contestId);
  if (c.state !== "noticed") return fail("bad_state", "Generate the notice first", 409);
  if (c.notice_receipt) return fail("already_set", "Receipt already recorded", 409);
  if (!(receipt ?? "").trim()) return fail("receipt_required", "Receipt reference required");
  if (badReceipt(receipt)) return fail("bad_receipt", RECEIPT_MSG);
  receipt = receipt.trim();
  await ctx.commit(async (tx) => {
    await tx.query("UPDATE contests SET notice_receipt=$2 WHERE id=$1", [contestId, receipt]);
    await ctx.events.emit(tx, { type: "contest.notice_receipt", data: { contest_id: contestId, receipt_hash: sha256hex(receipt) } });
  });
}

// ---- Register ---------------------------------------------------------------------------------

import { checkAppealPeriod, notifyExcluded } from "./record-notices.js";

export interface IncompleteMember { memberId: string; cardNo: string; missing: string[] }

/** Sort every active member into complete records (ready for the register) and incomplete ones (named, with the fields they lack). */
export async function sortRegisterCandidates(ctx: Ctx) {
  const members = await ctx.db.query<{ id: string; card_no: string; record_enc: string }>(
    "SELECT id, card_no, record_enc FROM members WHERE state='active' AND activated_at <= $1 ORDER BY card_no", [ctx.clock().toISOString()]);
  const complete: { id: string; row: RegisterRecord & { card_no: string } }[] = [];
  const incomplete: (IncompleteMember & { phone?: string })[] = [];
  for (const m of members) {
    const rec = await ctx.keys.decrypt<RegisterRecord>(m.id, m.record_enc);
    const missing = missingRegisterFields(rec, ctx.config.get<string[]>("register.fields"));
    if (missing.length) { incomplete.push({ memberId: m.id, cardNo: m.card_no, missing, phone: rec.phone }); continue; }
    const { phone: _phone, ...legal } = rec;
    complete.push({ id: m.id, row: { card_no: m.card_no, ...legal } as any });
  }
  return { complete, incomplete };
}

/**
 * Read-only check before filing: who is complete, and which members would have to be left off (with the fields each lacks).
 * After the freeze it shows who WAS left off. Uses card numbers, never names.
 */
export async function previewRegister(ctx: Ctx, contestId: string) {
  const c = await getContest(ctx, contestId);
  if (c.register_id) {
    const ex = await ctx.db.query<{ member_id: string; card_no: string; missing: string }>("SELECT member_id, card_no, missing FROM register_exclusions WHERE register_id=$1 ORDER BY card_no", [c.register_id]);
    const filed = await ctx.db.query<{ member_count: number }>("SELECT member_count FROM registers WHERE id=$1", [c.register_id]);
    return { frozen: true, registerId: c.register_id, completeCount: filed[0].member_count, incomplete: ex.map((e) => ({ memberId: e.member_id, cardNo: e.card_no, missing: e.missing.split(",") })) };
  }
  const { complete, incomplete } = await sortRegisterCandidates(ctx);
  const dueAt = new Date(new Date(c.vote_date).getTime() - ctx.config.get<number>("register.days_before_contest") * DAY);
  const noticed = await Promise.all(incomplete.map(async (i) => ({
    memberId: i.memberId, cardNo: i.cardNo, missing: i.missing,
    firstNoticeAt: (await ctx.db.query<{ t: string | null }>("SELECT MIN(sent_at) AS t FROM record_notices WHERE member_id=$1 AND kind='incomplete'", [i.memberId]))[0].t,
  })));
  return { frozen: false, completeCount: complete.length, filingDeadline: dueAt.toISOString(), incomplete: noticed };
}

/**
 * Freeze the register for a contest: snapshot active members, check every s.77(2) field, fingerprint it,
 * and post the fingerprint to the log. Filing must be at least register.days_before_contest days before the contest.
 *
 * An incomplete record normally stops the filing, with every incomplete member named in `details`. The admin may instead choose
 * `excludeIncomplete`: the complete records are filed, the rest are recorded in register_exclusions (so they can be shown to the admin
 * and cannot vote: they are not on the register), and the public log carries only the COUNT left off, never who.
 */
export async function freezeRegister(ctx: Ctx, contestId: string, opts: { excludeIncomplete?: boolean } = {}) {
  const c = await getContest(ctx, contestId);
  if (c.register_id) return fail("already_frozen", "Register already frozen for this contest", 409);
  const regDays = ctx.config.get<number>("register.days_before_contest");
  if ((new Date(c.vote_date).getTime() - ctx.clock().getTime()) / DAY < regDays)
    return fail("register_late", `Register must be filed at least ${regDays} days before the contest`, 422);

  const { complete, incomplete } = await sortRegisterCandidates(ctx);
  if (incomplete.length && !opts.excludeIncomplete) {
    const shown = incomplete.slice(0, 20).map((i) => `${i.cardNo} missing: ${i.missing.join(", ")}`).join("; ");
    return fail("incomplete_record", `${incomplete.length} member record(s) incomplete: ${shown}${incomplete.length > 20 ? "; ..." : ""}. Fix them, or file the ${complete.length} complete records only.`, 422,
      { completeCount: complete.length, incomplete: incomplete.map(({ phone: _p, ...i }) => i) });
  }
  if (incomplete.length) await checkAppealPeriod(ctx, incomplete, new Date(new Date(c.vote_date).getTime() - regDays * DAY));
  if (!complete.length && incomplete.length) return fail("empty_register", "Every member record is incomplete, so there is nothing to file", 422, { incomplete: incomplete.map(({ phone: _p, ...i }) => i) });
  const rows = complete.map((m) => m.row);
  const exportJson = canonical({ contest_id: contestId, frozen_at: ctx.clock().toISOString(), members: rows });
  const fingerprint = sha256hex(exportJson);
  const id = randomUUID();

  await ctx.commit(async (tx) => {
    await ctx.keys.createKey(`register:${id}`, tx);
    await tx.query(
      "INSERT INTO registers(id,contest_id,frozen_at,fingerprint,member_count,export_json) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, contestId, ctx.clock().toISOString(), fingerprint, rows.length, await ctx.keys.encrypt(`register:${id}`, JSON.parse(exportJson), tx)]);
    for (const m of complete) await tx.query("INSERT INTO register_members(register_id,member_id) VALUES ($1,$2)", [id, m.id]);
    for (const i of incomplete) await tx.query("INSERT INTO register_exclusions(register_id,member_id,card_no,missing) VALUES ($1,$2,$3,$4)", [id, i.memberId, i.cardNo, i.missing.join(",")]);
    await tx.query("UPDATE contests SET register_id=$2 WHERE id=$1", [contestId, id]);
    await ctx.events.emit(tx, { type: "register.frozen", data: { contest_id: contestId, register_id: id, fingerprint, member_count: rows.length, excluded_count: incomplete.length } });
  });
  await notifyExcluded(ctx, id, incomplete);
  return { registerId: id, fingerprint, memberCount: rows.length, excludedCount: incomplete.length };
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
  if (!(receipt ?? "").trim()) return fail("receipt_required", "Receipt reference required");
  if (badReceipt(receipt)) return fail("bad_receipt", RECEIPT_MSG);
  receipt = receipt.trim();
  await ctx.commit(async (tx) => {
    const r = await tx.query("UPDATE registers SET inec_receipt=$2 WHERE id=$1 AND inec_receipt IS NULL RETURNING id", [registerId, receipt]);
    if (!r.length) return fail("bad_state", "Unknown register or receipt already recorded", 409);
    await ctx.events.emit(tx, { type: "register.receipt", data: { register_id: registerId, receipt_hash: sha256hex(receipt) } });
  });
}

// ---- Opening the contest ----------------------------------------------------------------------

/** Voting stays locked until every earlier legal step has a stored receipt. */
export async function openContest(ctx: Ctx, contestId: string) {
  const c = await getContest(ctx, contestId);
  if (c.state === "open") return fail("already_open", "Contest is already open", 409);
  if (c.state === "closed") return fail("already_closed", "Contest is closed and cannot be reopened", 409);
  if (c.state !== "noticed") return fail("not_noticed", "Contest has no notice", 409);
  if (!c.notice_receipt) return fail("no_notice_receipt", "INEC notice receipt not recorded", 423);
  if (!c.register_id) return fail("no_register", "Register not frozen", 423);
  const reg = await ctx.db.query<{ inec_receipt: string | null }>("SELECT inec_receipt FROM registers WHERE id=$1", [c.register_id]);
  if (!reg[0]?.inec_receipt) return fail("no_register_receipt", "INEC register receipt not recorded", 423);
  if (ctx.clock().getTime() < new Date(c.vote_date).getTime()) return fail("too_early", "Voting cannot open before the vote date", 425);
  if (await rulesHash(ctx) !== c.rules_hash) return fail("rules_changed", "Rules differ from those in the notice", 500);
  await ctx.commit(async (tx) => {
    await tx.query("UPDATE contests SET state='open' WHERE id=$1", [contestId]);
    await ctx.events.emit(tx, { type: "contest.opened", data: { contest_id: contestId } });
  });
}

export async function closeContest(ctx: Ctx, contestId: string) {
  const c = await getContest(ctx, contestId);
  if (c.state === "closed") return fail("already_closed", "Contest is already closed", 409);
  if (c.state === "open" && ctx.clock().getTime() < new Date(c.vote_date).getTime()) return fail("too_early", "Voting cannot close before the vote date", 425);
  await ctx.commit(async (tx) => {
    const r = await tx.query("UPDATE contests SET state='closed' WHERE id=$1 AND state='open' RETURNING id", [contestId]);
    if (!r.length) return fail("bad_state", "Contest is not open", 409);
    await ctx.events.emit(tx, { type: "contest.closed", data: { contest_id: contestId } });
  });
}

/**
 * May this member vote in this contest? Only if they are on the frozen register AND still an active member. A member who resigns or is
 * erased after the freeze stays on the filed register (it is a snapshot) but loses the right to vote; the voting module must call this.
 */
export async function isEligible(ctx: Ctx, contestId: string, memberId: string): Promise<boolean> {
  const c = await getContest(ctx, contestId);
  if (!c.register_id) return false;
  const r = await ctx.db.query(
    "SELECT 1 FROM register_members rm JOIN members m ON m.id=rm.member_id WHERE rm.register_id=$1 AND rm.member_id=$2 AND m.state='active'", [c.register_id, memberId]);
  return r.length > 0;
}

export { logRef };
