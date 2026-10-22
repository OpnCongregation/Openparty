import type { Ctx } from "./context.js";
import { logRef } from "./context.js";
import type { IncomingPayment } from "./adapters.js";
import { getRule } from "./contests.js";
import { DomainError, fail } from "./errors.js";

export interface Donor {
  name: string;
  address: string;
  occupation: string;
}

/** Foreign money is never accepted (Nigeria pack: s.89, Reg 42); it is quarantined and flagged for reporting. */
async function rejectForeign(ctx: Ctx, p: IncomingPayment) {
  const okCurrency = ctx.config.get<string[]>("finance.accepted_currency");
  const okCountry = ctx.config.get<string[]>("finance.accepted_country");
  if (okCurrency.includes(p.currency) && okCountry.includes(p.country)) return;
  await ctx.db.query("INSERT INTO quarantine(reason,amount_minor,external_ref) VALUES ('foreign_funds',$1,$2)", [p.amountMinor, p.ref]);
  await ctx.log.append({ type: "finance.quarantined", data: { reason: "foreign_funds", amount_minor: p.amountMinor } });
  return fail("foreign_funds", "Foreign funds are not accepted; quarantined for reporting to the regulator", 422);
}

async function insertLedger(ctx: Ctx, row: {
  kind: "dues" | "gift"; amountMinor: number; memberId?: string; donorKey?: string; donorEnc?: string; ref: string;
}) {
  try {
    const r = await ctx.db.query<{ id: number }>(
      `INSERT INTO finance_ledger(kind,amount_minor,member_id,donor_key,donor_enc,external_ref,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::int AS id`,
      [row.kind, row.amountMinor, row.memberId ?? null, row.donorKey ?? null, row.donorEnc ?? null, row.ref, ctx.clock().toISOString()]);
    return r[0].id;
  } catch (e: any) {
    if (String(e.message).includes("external_ref")) return fail("duplicate_payment", "Payment already recorded", 409);
    throw e;
  }
}

/** Rules that can be checked before any money moves. */
async function checkDuesAllowed(ctx: Ctx, memberId: string, amountMinor: number) {
  const m = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [memberId]);
  if (!m.length || !["provisional", "active"].includes(m[0].state)) return fail("not_member", "Dues need a current member", 403);
  const min = await getRule<number>(ctx, "dues.min_payment_minor");
  if (amountMinor < min) return fail("dues_too_low", `Minimum dues is ${min} ${ctx.config.pack.currency.minor_unit}`, 422);
}

export async function recordDues(ctx: Ctx, memberId: string, p: IncomingPayment) {
  await rejectForeign(ctx, p);
  await checkDuesAllowed(ctx, memberId, p.amountMinor);
  const id = await insertLedger(ctx, { kind: "dues", amountMinor: p.amountMinor, memberId, ref: p.ref });
  await ctx.log.append({ type: "finance.dues", data: { ledger_id: id, amount_minor: p.amountMinor, member_ref: logRef(ctx, "member", memberId) } });
  return { ledgerId: id };
}

interface Attempt { key: string; member_id: string; amount_minor: number; state: string; ref: string | null; currency: string | null; country: string | null; ledger_id: number | null; error: string | null }

const setAttempt = (ctx: Ctx, key: string, state: string, extra: { ref?: string; currency?: string; country?: string; ledgerId?: number; error?: string | null } = {}) =>
  ctx.db.query(
    `UPDATE payment_attempts SET state=$2, ref=COALESCE($3,ref), currency=COALESCE($4,currency), country=COALESCE($5,country),
       ledger_id=COALESCE($6,ledger_id), error=$7, updated_at=now() WHERE key=$1`,
    [key, state, extra.ref ?? null, extra.currency ?? null, extra.country ?? null, extra.ledgerId ?? null, extra.error ?? null]);

/** Record a confirmed payment and move its attempt to its final state. Safe to repeat: the ledger's external_ref is unique. */
async function settle(ctx: Ctx, a: Pick<Attempt, "key" | "member_id">, p: IncomingPayment): Promise<{ ledgerId: number }> {
  try {
    const r = await recordDues(ctx, a.member_id, p);
    await setAttempt(ctx, a.key, "recorded", { ledgerId: r.ledgerId });
    return r;
  } catch (e: any) {
    if (e instanceof DomainError && e.code === "duplicate_payment") {
      // A previous run recorded it but died before updating the attempt: adopt the existing ledger row.
      const row = await ctx.db.query<{ id: number }>("SELECT id::int AS id FROM finance_ledger WHERE external_ref=$1", [p.ref]);
      if (row.length) {
        await setAttempt(ctx, a.key, "recorded", { ledgerId: row[0].id });
        return { ledgerId: row[0].id };
      }
    }
    // A rule refused money that the provider already took: it must be refunded, so keep it visible rather than lost.
    if (e instanceof DomainError) await setAttempt(ctx, a.key, "refund_due", { error: `${e.code}: ${e.message}` });
    // Anything else (database down, crash) leaves 'charged' so retryUnrecorded can finish the job.
    throw e;
  }
}

/**
 * Collect dues exactly once per idempotency key. The attempt is written before the provider is called, the provider gets
 * the same key on every retry, and the ledger row is keyed by the provider's reference, so a repeated request, a timeout
 * or a crash between "charged" and "recorded" can neither charge twice nor lose the payment.
 */
export async function collectDues(ctx: Ctx, memberId: string, phone: string, amountMinor: number, key: string) {
  await checkDuesAllowed(ctx, memberId, amountMinor);
  await ctx.db.query(
    "INSERT INTO payment_attempts(key,member_id,amount_minor,state) VALUES ($1,$2,$3,'charging') ON CONFLICT (key) DO NOTHING", [key, memberId, amountMinor]);
  const a = (await ctx.db.query<Attempt>("SELECT * FROM payment_attempts WHERE key=$1", [key]))[0];
  if (a.member_id !== memberId || Number(a.amount_minor) !== amountMinor) return fail("key_reuse", "That payment key was used for a different payment", 409);
  if (a.state === "recorded") return { ledgerId: a.ledger_id as number, amountMinor, duplicate: true as const };
  if (a.state === "refund_due") return fail("refund_due", a.error ?? "Payment was taken and refused; a refund is due", 422);

  let p: IncomingPayment;
  if (a.state === "charged" && a.ref) {
    p = { ref: a.ref, amountMinor, currency: a.currency ?? "", country: a.country ?? "" };
  } else {
    try {
      p = await ctx.payments.charge(phone, amountMinor, key);
    } catch (e: any) {
      // Outcome unknown: stay in 'charging' (reported by reconcile) and ask the person to try again. The same key makes a retry safe.
      await setAttempt(ctx, key, "charging", { error: String(e?.message ?? e).slice(0, 200) });
      return fail("payment_unconfirmed", "We could not confirm the payment. You have not been charged twice; try again shortly.", 502);
    }
    await setAttempt(ctx, key, "charged", { ref: p.ref, currency: p.currency, country: p.country });
  }
  const r = await settle(ctx, a, p);
  return { ledgerId: r.ledgerId, payment: p, amountMinor, duplicate: false as const };
}

/** Finish payments the provider confirmed but the ledger never got (crash or outage between the two). */
export async function retryUnrecorded(ctx: Ctx) {
  const rows = await ctx.db.query<Attempt>("SELECT * FROM payment_attempts WHERE state='charged' ORDER BY created_at");
  const out = { recorded: 0, refundDue: 0, stillFailing: 0 };
  for (const a of rows) {
    try {
      await settle(ctx, a, { ref: a.ref as string, amountMinor: Number(a.amount_minor), currency: a.currency ?? "", country: a.country ?? "" });
      out.recorded++;
    } catch (e) {
      if (e instanceof DomainError) out.refundDue++;
      else out.stillFailing++;
    }
  }
  return out;
}

/**
 * Every gift records the donor (s.94(1) bans anonymous gifts) and is capped per donor.
 * Donor identity is encrypted under its own key; party leaders have no read path to it.
 */
export async function recordGift(ctx: Ctx, p: IncomingPayment, donor: Donor) {
  await rejectForeign(ctx, p);
  for (const f of ctx.config.get<string[]>("finance.donor_fields"))
    if (!(donor as any)?.[f]?.trim()) return fail("anonymous_gift", `Donor ${f} is required; anonymous gifts are illegal`, 422);

  // The party's cap can never exceed the pack's legal ceiling (setRule refuses it), so this min() is a second lock.
  const ceiling = ctx.config.pack.params["finance.cap_per_donor_minor"] as number;
  const cap = Math.min(await getRule<number>(ctx, "finance.cap_per_donor_minor"), ceiling);
  const windowDays = await getRule<number | null>(ctx, "finance.cap_window_days");
  const donorKey = ctx.keys.lookupHash("donor", `${donor.name.trim().toLowerCase()}|${donor.address.trim().toLowerCase()}`);
  // A rolling window when the party sets one (DDPN: a year); otherwise the cap is over the donor's lifetime.
  const since = windowDays ? new Date(ctx.clock().getTime() - windowDays * 86_400_000).toISOString() : null;
  const prior = (await ctx.db.query<{ t: number }>(
    `SELECT COALESCE(SUM(amount_minor),0)::float8 AS t FROM finance_ledger
     WHERE kind='gift' AND donor_key=$1 AND ($2::timestamptz IS NULL OR COALESCE(occurred_at, at) >= $2::timestamptz)`, [donorKey, since]))[0].t;
  if (prior + p.amountMinor > cap) return fail("over_cap", "Gift would exceed the per-donor cap", 422);

  const keyId = `donor:${donorKey}`;
  if (!(await ctx.db.query("SELECT 1 FROM member_keys WHERE member_id=$1", [keyId])).length) await ctx.keys.createKey(keyId);
  const id = await insertLedger(ctx, {
    kind: "gift", amountMinor: p.amountMinor, donorKey, donorEnc: await ctx.keys.encrypt(keyId, donor), ref: p.ref });
  await ctx.log.append({ type: "finance.gift", data: { ledger_id: id, amount_minor: p.amountMinor } });
  return { ledgerId: id };
}

/** Donor report for the regulator (Nigeria pack: Reg 44). Auditor-only; the caller must log the access. */
export async function donorReport(ctx: Ctx) {
  const rows = await ctx.db.query<{ donor_key: string; donor_enc: string; amount_minor: number; id: number }>(
    "SELECT id::int AS id, donor_key, donor_enc, amount_minor::float8 AS amount_minor FROM finance_ledger WHERE kind='gift' ORDER BY id");
  const out = [];
  for (const r of rows) out.push({ ledgerId: r.id, amountMinor: r.amount_minor, donor: await ctx.keys.decrypt<Donor>(`donor:${r.donor_key}`, r.donor_enc) });
  return out;
}

/** Reports must reconcile to the ledger: every figure derives from the same append-only rows. */
export async function reconcile(ctx: Ctx) {
  const t = await ctx.db.query<{ kind: string; total: number; n: number }>(
    "SELECT kind, SUM(amount_minor)::float8 AS total, COUNT(*)::int AS n FROM finance_ledger GROUP BY kind");
  const byKind = Object.fromEntries(t.map((r) => [r.kind, { totalMinor: r.total, count: r.n }]));
  const giftsInReport = (await donorReport(ctx)).reduce((s, r) => s + r.amountMinor, 0);
  const unsettled = await ctx.db.query<{ state: string; n: number; total: number }>(
    "SELECT state, COUNT(*)::int AS n, COALESCE(SUM(amount_minor),0)::float8 AS total FROM payment_attempts WHERE state <> 'recorded' GROUP BY state");
  const unsettledPayments = Object.fromEntries(unsettled.map((r) => [r.state, { count: r.n, totalMinor: r.total }]));
  const ok = giftsInReport === (byKind.gift?.totalMinor ?? 0) && unsettled.length === 0;
  return { byKind, giftsInReportMinor: giftsInReport, unsettledPayments, reconciled: ok };
}
