import type { Ctx } from "./context.js";
import { logRef } from "./context.js";
import type { IncomingPayment } from "./adapters.js";
import { getRule } from "./contests.js";
import type { Db } from "./db.js";
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
  // Quarantine and its public event commit together; the refusal is raised only after that commit.
  await ctx.commit(async (tx) => {
    await tx.query("INSERT INTO quarantine(reason,amount_minor,external_ref) VALUES ('foreign_funds',$1,$2)", [p.amountMinor, p.ref]);
    await ctx.events.emit(tx, { type: "finance.quarantined", data: { reason: "foreign_funds", amount_minor: p.amountMinor } });
  });
  return fail("foreign_funds", "Foreign funds are not accepted; quarantined for reporting to the regulator", 422);
}

async function insertLedger(ctx: Ctx, db: Db, row: {
  kind: "dues" | "gift" | "form"; amountMinor: number; memberId?: string; donorKey?: string; donorEnc?: string; ref: string; contestId?: string;
}) {
  // ON CONFLICT instead of catching the unique violation: inside a transaction a failed statement would poison it.
  const r = await db.query<{ id: number }>(
    `INSERT INTO finance_ledger(kind,amount_minor,member_id,donor_key,donor_enc,external_ref,occurred_at,contest_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (external_ref) DO NOTHING RETURNING id::int AS id`,
    [row.kind, row.amountMinor, row.memberId ?? null, row.donorKey ?? null, row.donorEnc ?? null, row.ref, ctx.clock().toISOString(), row.contestId ?? null]);
  if (!r.length) return fail("duplicate_payment", "Payment already recorded", 409);
  return r[0].id;
}

/** Rules that can be checked before any money moves. */
async function checkDuesAllowed(ctx: Ctx, memberId: string, amountMinor: number) {
  const m = await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [memberId]);
  if (!m.length || !["provisional", "active"].includes(m[0].state)) return fail("not_member", "Dues need a current member", 403);
  const min = await getRule<number>(ctx, "dues.min_payment_minor");
  if (amountMinor < min) return fail("dues_too_low", `Minimum dues is ${min} ${ctx.config.pack.currency.minor_unit}`, 422);
}

/** `inSameTx` runs inside the transaction that writes the ledger row, so a caller's own bookkeeping commits with it. */
export async function recordDues(ctx: Ctx, memberId: string, p: IncomingPayment, inSameTx?: (tx: Db, ledgerId: number) => Promise<unknown>) {
  await rejectForeign(ctx, p);
  await checkDuesAllowed(ctx, memberId, p.amountMinor);
  const id = await ctx.commit(async (tx) => {
    const id = await insertLedger(ctx, tx, { kind: "dues", amountMinor: p.amountMinor, memberId, ref: p.ref });
    await ctx.events.emit(tx, { type: "finance.dues", data: { ledger_id: id, amount_minor: p.amountMinor, member_ref: logRef(ctx, "member", memberId) } });
    await inSameTx?.(tx, id);
    return id;
  });
  return { ledgerId: id };
}

/**
 * A candidate's form fee. The ledger row, the attempt, the candidacy turning 'listed' and both public events commit in ONE transaction,
 * exactly like dues, so a crash can never leave a paid fee without a listed candidate or the reverse.
 */
export async function recordFormFee(ctx: Ctx, memberId: string, candidacyId: string, p: IncomingPayment, inSameTx?: (tx: Db, ledgerId: number) => Promise<unknown>) {
  await rejectForeign(ctx, p);
  const id = await ctx.commit(async (tx) => {
    const c = (await tx.query<{ fee_minor: number; contest_id: string; member_id: string }>(
      "SELECT fee_minor::float8 AS fee_minor, contest_id, member_id FROM candidacies WHERE id=$1 FOR UPDATE", [candidacyId]))[0];
    if (!c || c.member_id !== memberId) return fail("not_found", "No such candidacy", 404);
    if (Number(c.fee_minor) !== p.amountMinor) return fail("fee_mismatch", "The amount does not match the form fee", 422);
    const id = await insertLedger(ctx, tx, { kind: "form", amountMinor: p.amountMinor, memberId, ref: p.ref, contestId: c.contest_id });
    await ctx.events.emit(tx, { type: "finance.form", data: { ledger_id: id, amount_minor: p.amountMinor, candidacy_id: candidacyId } });
    await inSameTx?.(tx, id);
    return id;
  });
  return { ledgerId: id };
}

/** Turn a paid candidacy into a listed one (idempotent) and publish it. */
async function markFormPaid(ctx: Ctx, tx: Db, candidacyId: string, ledgerId: number) {
  const r = await tx.query<{ race_id: string; contest_id: string }>(
    "UPDATE candidacies SET state='listed', fee_ledger_id=$2, listed_at=$3 WHERE id=$1 AND state='pending_payment' RETURNING race_id, contest_id",
    [candidacyId, ledgerId, ctx.clock().toISOString()]);
  if (r.length) await ctx.events.emit(tx, { type: "candidate.listed", data: { contest_id: r[0].contest_id, race_id: r[0].race_id, candidacy_id: candidacyId } });
}

interface Attempt { kind: string; purpose_id: string | null; key: string; member_id: string; amount_minor: number; state: string; ref: string | null; currency: string | null; country: string | null; ledger_id: number | null; error: string | null }

const setAttempt = (db: Db, key: string, state: string, extra: { ref?: string; currency?: string; country?: string; ledgerId?: number; error?: string | null } = {}) =>
  db.query(
    `UPDATE payment_attempts SET state=$2, ref=COALESCE($3,ref), currency=COALESCE($4,currency), country=COALESCE($5,country),
       ledger_id=COALESCE($6,ledger_id), error=$7, updated_at=now() WHERE key=$1`,
    [key, state, extra.ref ?? null, extra.currency ?? null, extra.country ?? null, extra.ledgerId ?? null, extra.error ?? null]);

/** Record a confirmed payment and move its attempt to its final state. Safe to repeat: the ledger's external_ref is unique. */
async function settle(ctx: Ctx, a: Pick<Attempt, "key" | "member_id" | "kind" | "purpose_id">, p: IncomingPayment): Promise<{ ledgerId: number }> {
  const finish = async (tx: Db, ledgerId: number) => {
    await setAttempt(tx, a.key, "recorded", { ledgerId });
    if (a.kind === "form") await markFormPaid(ctx, tx, a.purpose_id as string, ledgerId);
  };
  try {
    return a.kind === "form" ? await recordFormFee(ctx, a.member_id, a.purpose_id as string, p, finish) : await recordDues(ctx, a.member_id, p, finish);
  } catch (e: any) {
    if (e instanceof DomainError && e.code === "duplicate_payment") {
      // The ledger already has this payment (an older run recorded it and died before finishing). Adopt it, but do not trust that
      // its public event exists: check, and re-emit it in the same transaction if it is missing, so ledger, attempt and log converge.
      const row = await ctx.db.query<{ id: number }>("SELECT id::int AS id FROM finance_ledger WHERE external_ref=$1 AND kind=$2", [p.ref, a.kind === "form" ? "form" : "dues"]);
      if (row.length) {
        const ledgerId = row[0].id;
        await ctx.commit(async (tx) => {
          const type = a.kind === "form" ? "finance.form" : "finance.dues";
          const have = await tx.query("SELECT 1 FROM log_outbox WHERE type=$2 AND (data::jsonb ->> 'ledger_id') = $1 LIMIT 1", [String(ledgerId), type]);
          if (!have.length) await ctx.events.emit(tx, {
            type, data: a.kind === "form" ? { ledger_id: ledgerId, amount_minor: p.amountMinor, candidacy_id: a.purpose_id }
              : { ledger_id: ledgerId, amount_minor: p.amountMinor, member_ref: logRef(ctx, "member", a.member_id) } });
          await setAttempt(tx, a.key, "recorded", { ledgerId });
          if (a.kind === "form") await markFormPaid(ctx, tx, a.purpose_id as string, ledgerId);
        });
        return { ledgerId };
      }
    }
    // A rule refused money that the provider already took: it must be refunded, so keep it visible rather than lost.
    if (e instanceof DomainError) await setAttempt(ctx.db, a.key, "refund_due", { error: `${e.code}: ${e.message}` });
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
  return collect(ctx, { kind: "dues", purposeId: null }, memberId, phone, amountMinor, key);
}

/**
 * Collect a candidate's form fee, once. The key is fixed per candidacy, so a repeated request, a timeout or a crash can neither
 * charge twice nor lose the payment, and the candidacy becomes 'listed' in the same transaction that records the fee.
 */
export async function collectFormFee(ctx: Ctx, memberId: string, phone: string, candidacyId: string) {
  const c = (await ctx.db.query<{ fee_minor: number; state: string; member_id: string; contest_state: string }>(
    "SELECT k.fee_minor::float8 AS fee_minor, k.state, k.member_id, c.state AS contest_state FROM candidacies k JOIN contests c ON c.id=k.contest_id WHERE k.id=$1", [candidacyId]))[0];
  if (!c || c.member_id !== memberId) return fail("not_found", "No such candidacy", 404);
  if (c.state === "listed") return fail("already_paid", "The form fee is already paid", 409);
  if (c.state !== "pending_payment") return fail("bad_state", "This candidacy was withdrawn", 409);
  if (c.contest_state === "open" || c.contest_state === "closed") return fail("candidacy_closed", "Candidacy closed when voting opened", 409);
  const sealed = await ctx.db.query("SELECT 1 FROM election_keys k JOIN candidacies x ON x.contest_id=k.contest_id WHERE x.id=$1 AND k.sealed_at IS NOT NULL", [candidacyId]);
  if (sealed.length) return fail("candidacy_closed", "Candidacy closed when the election was sealed", 409);
  if (!(Number(c.fee_minor) > 0)) return fail("no_fee", "There is no fee to pay", 409);
  return collect(ctx, { kind: "form", purposeId: candidacyId }, memberId, phone, Number(c.fee_minor), `form:${candidacyId}`);
}

async function collect(ctx: Ctx, what: { kind: "dues" | "form"; purposeId: string | null }, memberId: string, phone: string, amountMinor: number, key: string) {
  await ctx.db.query(
    "INSERT INTO payment_attempts(key,member_id,amount_minor,state,kind,purpose_id) VALUES ($1,$2,$3,'charging',$4,$5) ON CONFLICT (key) DO NOTHING", [key, memberId, amountMinor, what.kind, what.purposeId]);
  const a = (await ctx.db.query<Attempt>("SELECT * FROM payment_attempts WHERE key=$1", [key]))[0];
  if (a.member_id !== memberId || Number(a.amount_minor) !== amountMinor) return fail("key_reuse", "That payment key was used for a different payment", 409);
  // BIGINT columns come back from a real Postgres server as strings (the embedded one returns numbers): convert.
  if (a.state === "recorded") return { ledgerId: Number(a.ledger_id), amountMinor, duplicate: true as const };
  if (a.state === "refund_due") return fail("refund_due", a.error ?? "Payment was taken and refused; a refund is due", 422);

  let p: IncomingPayment;
  if (a.state === "charged" && a.ref) {
    p = { ref: a.ref, amountMinor, currency: a.currency ?? "", country: a.country ?? "" };
  } else {
    try {
      p = await ctx.payments.charge(phone, amountMinor, key);
    } catch (e: any) {
      // Outcome unknown: stay in 'charging' (reported by reconcile) and ask the person to try again. The same key makes a retry safe.
      await setAttempt(ctx.db, key, "charging", { error: String(e?.message ?? e).slice(0, 200) });
      return fail("payment_unconfirmed", "We could not confirm the payment. You have not been charged twice; try again shortly.", 502);
    }
    await setAttempt(ctx.db, key, "charged", { ref: p.ref, currency: p.currency, country: p.country });
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
  const donorKey = ctx.keys.refHash("donor", `${donor.name.trim().toLowerCase()}|${donor.address.trim().toLowerCase()}`);
  // A rolling window when the party sets one (DDPN: a year); otherwise the cap is over the donor's lifetime.
  const since = windowDays ? new Date(ctx.clock().getTime() - windowDays * 86_400_000).toISOString() : null;
  const keyId = `donor:${donorKey}`;
  const id = await ctx.commit(async (tx) => {
    // Serialise gifts from one donor, then check the cap inside the same transaction as the insert, so two gifts arriving
    // together cannot both pass a check made before either was written.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [donorKey]);
    const prior = (await tx.query<{ t: number }>(
      `SELECT COALESCE(SUM(amount_minor),0)::float8 AS t FROM finance_ledger
       WHERE kind='gift' AND donor_key=$1 AND ($2::timestamptz IS NULL OR COALESCE(occurred_at, at) >= $2::timestamptz)`, [donorKey, since]))[0].t;
    if (prior + p.amountMinor > cap) return fail("over_cap", "Gift would exceed the per-donor cap", 422);
    if (!(await tx.query("SELECT 1 FROM member_keys WHERE member_id=$1", [keyId])).length) await ctx.keys.createKey(keyId, tx);
    const id = await insertLedger(ctx, tx, {
      kind: "gift", amountMinor: p.amountMinor, donorKey, donorEnc: await ctx.keys.encrypt(keyId, donor, tx), ref: p.ref });
    await ctx.events.emit(tx, { type: "finance.gift", data: { ledger_id: id, amount_minor: p.amountMinor } });
    return id;
  });  return { ledgerId: id };
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
