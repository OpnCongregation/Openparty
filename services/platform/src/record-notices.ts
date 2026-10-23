import type { Ctx } from "./context.js";
import { DAY, logRef } from "./context.js";
import { fail } from "./errors.js";
import { t } from "./i18n.js";
import { missingRegisterFields, type RegisterRecord } from "./members.js";

/**
 * Appeal period for incomplete member records. No screen is involved: members get SMS notices naming what is missing and, when a
 * contest is coming, the date the register must be filed by. They can complete the record at any time (USSD option 4 for the fields a
 * member can supply; a ward agent for the rest), and at filing time only complete records go on the register.
 */

/** Fields a member can type in on a phone. The rest come from the ID check (name, sex, birth date, ID number) or need a person (ward, photo). */
export const SELF_SERVICE_FIELDS = ["address", "state", "lga", "polling_unit", "disability_status"] as const;

/** An exclusion needs the member to have been told and given this long, unless the filing deadline is now within a day. */
export const APPEAL_MIN_DAYS = 7;
/** Reminders: again when the deadline is this many days off, and otherwise weekly. */
const REMINDER_DAYS_BEFORE = [3, 1];
const REMINDER_EVERY_DAYS = 7;

const label = (f: string) => f.replace(/_/g, " ");
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The register filing deadline of the nearest contest that has no register yet, or null when none is coming. */
export async function nextFilingDeadline(ctx: Ctx): Promise<{ contestId: string; due: Date; voteDate: Date } | null> {
  const r = await ctx.db.query<{ id: string; vote_date: string }>("SELECT id, vote_date FROM contests WHERE register_id IS NULL AND state IN ('draft','noticed') ORDER BY vote_date LIMIT 1");
  if (!r.length) return null;
  const voteDate = new Date(r[0].vote_date);
  return { contestId: r[0].id, voteDate, due: new Date(voteDate.getTime() - ctx.config.get<number>("register.days_before_contest") * DAY) };
}

/** Send (or repeat) the "your record is incomplete" notice to every active member who needs one. Safe to run often and from several instances. */
export async function sendRecordNotices(ctx: Ctx): Promise<{ sent: number; failed: number }> {
  const { sortRegisterCandidates } = await import("./contests.js"); // circular import otherwise
  const now = ctx.clock();
  const dl = await nextFilingDeadline(ctx);
  const daysLeft = dl ? (dl.due.getTime() - now.getTime()) / DAY : null;
  if (dl && daysLeft! < 0) return { sent: 0, failed: 0 }; // the deadline has passed: the register can no longer be filed in time
  const { incomplete } = await sortRegisterCandidates(ctx);
  if (!incomplete.length) return { sent: 0, failed: 0 };

  const due: { phone: string; missing: string[]; rowId: string }[] = [];
  await ctx.commit(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('record-notices'))");
    for (const m of incomplete) {
      if (!m.phone) continue;
      const last = (await tx.query<{ sent_at: string; stage: number | null; dated: boolean }>(
        "SELECT sent_at, stage, due_at IS NOT NULL AS dated FROM record_notices WHERE member_id=$1 AND kind='incomplete' ORDER BY id DESC LIMIT 1", [m.memberId]))[0];
      let send = false; let stage: number | null = null;
      if (!last) send = true;
      else if (dl) {
        const elapsed = (now.getTime() - new Date(last.sent_at).getTime()) / DAY;
        const crossed = REMINDER_DAYS_BEFORE.find((d) => daysLeft! <= d && (last.stage === null || last.stage > d));
        if (crossed !== undefined) { send = true; stage = crossed; }
        else if (!last.dated || elapsed >= REMINDER_EVERY_DAYS) send = true; // first dated notice after an undated one, or the weekly reminder
      } // with no contest coming there is no date to give: one notice only
      if (!send) continue;
      const rowId = String((await tx.query<{ id: string }>(
        "INSERT INTO record_notices(member_id, kind, sent_at, due_at, missing, stage) VALUES ($1,'incomplete',$2,$3,$4,$5) RETURNING id",
        [m.memberId, now.toISOString(), dl ? dl.due.toISOString() : null, m.missing.join(","), stage]))[0].id);
      due.push({ phone: m.phone, missing: m.missing, rowId });
    }
  });

  let sent = 0, failed = 0;
  for (const d of due) {
    const fields = d.missing.map(label).join(", ");
    const text = dl ? t(ctx, "sms.recordIncompleteDated", fields, day(dl.due)) : t(ctx, "sms.recordIncomplete", fields);
    try { await ctx.sms.send(d.phone, text); sent++; }
    catch { failed++; await ctx.db.query("DELETE FROM record_notices WHERE id=$1", [d.rowId]); } // so the next run tries again
  }
  return { sent, failed };
}

/** May the register be filed without these members? Only if each was told, and had the appeal period (or the deadline is a day away). */
export async function checkAppealPeriod(ctx: Ctx, incomplete: { memberId: string; cardNo: string }[], due: Date): Promise<void> {
  const now = ctx.clock();
  const nearDeadline = (due.getTime() - now.getTime()) / DAY <= 1;
  const problems: { cardNo: string; reason: string }[] = [];
  for (const m of incomplete) {
    const first = (await ctx.db.query<{ sent_at: string | null }>("SELECT MIN(sent_at) AS sent_at FROM record_notices WHERE member_id=$1 AND kind='incomplete'", [m.memberId]))[0]?.sent_at;
    if (!first) problems.push({ cardNo: m.cardNo, reason: "never notified" });
    else if (!nearDeadline && (now.getTime() - new Date(first).getTime()) / DAY < APPEAL_MIN_DAYS)
      problems.push({ cardNo: m.cardNo, reason: `notified ${day(new Date(first))}; appeal period of ${APPEAL_MIN_DAYS} days not over` });
  }
  if (problems.length)
    fail("appeal_open", `${problems.length} incomplete member(s) have not had their appeal period: ${problems.slice(0, 10).map((p) => `${p.cardNo} (${p.reason})`).join("; ")}. Run the notices, or wait.`, 409, { problems });
}

/** Tell members who were left off a filed register, once. */
export async function notifyExcluded(ctx: Ctx, registerId: string, members: { memberId: string; phone?: string }[]): Promise<void> {
  for (const m of members) {
    if (!m.phone) continue;
    const row = await ctx.db.query<{ id: string }>("INSERT INTO record_notices(member_id, kind, sent_at, missing, stage) VALUES ($1,'excluded',$2,$3,NULL) ON CONFLICT DO NOTHING RETURNING id", [m.memberId, ctx.clock().toISOString(), registerId]);
    if (!row.length) continue;
    try { await ctx.sms.send(m.phone, t(ctx, "sms.recordExcluded")); } catch { await ctx.db.query("DELETE FROM record_notices WHERE id=$1", [row[0].id]); }
  }
}

const VALUE_RE = /^[^*#\u0000-\u001f]{1,100}$/;

/**
 * Fill in missing register fields. Only fields that are currently EMPTY can be set (nothing already on file is overwritten here),
 * a member may set only SELF_SERVICE_FIELDS, and a ward agent may set any missing field except the verified ID number.
 */
export async function completeRecord(
  ctx: Ctx, memberId: string, values: Record<string, string>,
  by: { self: true } | { agent: { id: string; role: string; ward: string | null } },
) {
  const registerFields = ctx.config.get<string[]>("register.fields");
  const allowed = "self" in by ? SELF_SERVICE_FIELDS.filter((f) => registerFields.includes(f)) : registerFields.filter((f) => f !== "national_id");
  if ("agent" in by && by.agent.role !== "ward_agent") return fail("forbidden", "Only ward agents can complete a record for a member", 403);
  for (const [k, v] of Object.entries(values)) {
    if (!(allowed as readonly string[]).includes(k)) return fail("field_not_allowed", `${k} cannot be set this way`, 403);
    if (typeof v !== "string" || !VALUE_RE.test(v.trim())) return fail("bad_value", `${k}: 1 to 100 characters, no * or #`);
  }
  if (!Object.keys(values).length) return fail("nothing_to_do", "No values given");

  const result = await ctx.commit(async (tx) => {
    const rows = await tx.query<{ state: string; ward: string | null; record_enc: string }>("SELECT state, ward, record_enc FROM members WHERE id=$1 FOR UPDATE", [memberId]);
    if (!rows.length) return fail("not_found", "No such member", 404);
    if (rows[0].state !== "active") return fail("bad_state", `Member is ${rows[0].state}; only active members have a register record to complete`, 409);
    if ("agent" in by && by.agent.ward !== (rows[0].ward ?? values.ward)) return fail("wrong_ward", "Agent can only complete records in their own ward", 403);
    const rec = await ctx.keys.decrypt<RegisterRecord>(memberId, rows[0].record_enc, tx);
    const before = missingRegisterFields(rec, registerFields);
    for (const k of Object.keys(values)) if (!before.includes(k)) return fail("already_set", `${k} is already on file and cannot be changed this way`, 409);
    for (const [k, v] of Object.entries(values)) rec[k] = v.trim();
    const after = missingRegisterFields(rec, registerFields);
    await tx.query("UPDATE members SET record_enc=$2, ward=COALESCE($3, ward) WHERE id=$1", [memberId, await ctx.keys.encrypt(memberId, rec, tx), values.ward?.trim() ?? null]);
    if (!after.length) {
      await tx.query("UPDATE record_notices SET resolved_at=$2 WHERE member_id=$1 AND kind='incomplete' AND resolved_at IS NULL", [memberId, ctx.clock().toISOString()]);
      await ctx.events.emit(tx, { type: "member.record_completed", data: { member_ref: logRef(ctx, "member", memberId) } });
    }
    return { remaining: after, phone: rec.phone };
  });
  if (result.phone) {
    await ctx.sms.send(result.phone, result.remaining.length
      ? t(ctx, "sms.recordPartial", result.remaining.map(label).join(", "))
      : t(ctx, "sms.recordComplete")).catch(() => {});
  }
  return { remaining: result.remaining };
}
