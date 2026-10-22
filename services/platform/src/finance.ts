import type { Ctx } from "./context.js";
import { logRef } from "./context.js";
import type { IncomingPayment } from "./adapters.js";
import { getRule } from "./contests.js";
import { fail } from "./errors.js";

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

export async function recordDues(ctx: Ctx, memberId: string, p: IncomingPayment) {
  await rejectForeign(ctx, p);
  const m = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [memberId]);
  if (!m.length || !["provisional", "active"].includes(m[0].state)) return fail("not_member", "Dues need a current member", 403);
  const min = await getRule<number>(ctx, "dues.min_payment_minor");
  if (p.amountMinor < min) return fail("dues_too_low", `Minimum dues is ${min} ${ctx.config.pack.currency.minor_unit}`, 422);
  const id = await insertLedger(ctx, { kind: "dues", amountMinor: p.amountMinor, memberId, ref: p.ref });
  await ctx.log.append({ type: "finance.dues", data: { ledger_id: id, amount_minor: p.amountMinor, member_ref: logRef(ctx, "member", memberId) } });
  return { ledgerId: id };
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
  const ok = giftsInReport === (byKind.gift?.totalMinor ?? 0);
  return { byKind, giftsInReportMinor: giftsInReport, reconciled: ok };
}
