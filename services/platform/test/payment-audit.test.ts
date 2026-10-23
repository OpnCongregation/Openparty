import { describe, expect, it } from "vitest";
import { verifyConsistency } from "../src/consistency.js";
import * as finance from "../src/finance.js";
import { logRef } from "../src/context.js";
import type { IncomingPayment, LogEvent, Payments } from "../src/adapters.js";
import { joinAndActivate, makeAdmin, setup } from "./helpers.js";

class CountingPayments implements Payments {
  charges = 0;
  private byKey = new Map<string, IncomingPayment>();
  async charge(_p: string, amountMinor: number, key?: string): Promise<IncomingPayment> {
    const seen = key && this.byKey.get(key);
    if (seen) return seen;
    this.charges++;
    const pay = { ref: `AUD-${this.charges}`, amountMinor, currency: "NGN", country: "NG" };
    if (key) this.byKey.set(key, pay);
    return pay;
  }
}

async function member() {
  const s = await setup();
  const payments = new CountingPayments();
  s.ctx.payments = payments;
  const agent = await makeAdmin(s.ctx, "ward_agent", "W1");
  const m = await joinAndActivate(s.ctx, agent);
  return { ...s, payments, m };
}
const duesEvents = (log: { events: (LogEvent & { index: number })[] }) => log.events.filter((e) => e.type === "finance.dues");
const n = async (ctx: any, sql: string) => (await ctx.db.query(sql)).length as number;
const entries = (log: { events: LogEvent[] }) => log.events.map((e) => Buffer.from(JSON.stringify({ type: e.type, data: e.data, at: e.at, oid: e.oid })));

describe("F-13: a payment, its state and its public event always converge", () => {
  it("crash right after the ledger insert: the whole step rolls back and the retry completes it once", async () => {
    const { ctx, log, payments, m } = await member();
    const realTx = ctx.db.tx.bind(ctx.db);
    let crash = true;
    ctx.db.tx = ((fn: any) => realTx((tx: any) => {
      const q = tx.query.bind(tx);
      tx.query = async (sql: string, params?: unknown[]) => {
        const r = await q(sql, params);
        if (crash && sql.includes("INSERT INTO finance_ledger")) throw new Error("process died right after the ledger insert");
        return r;
      };
      return fn(tx);
    })) as typeof ctx.db.tx;

    await expect(finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-crash")).rejects.toThrow("died");
    expect(await n(ctx, "SELECT 1 FROM finance_ledger WHERE kind='dues'")).toBe(0); // ledger row, state and event rolled back together
    expect(duesEvents(log)).toHaveLength(0);
    expect(payments.charges).toBe(1); // the provider was charged once

    crash = false; // restart
    const r = await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-crash");
    expect(r.duplicate).toBe(false);
    expect(payments.charges).toBe(1); // the same key: no second charge
    expect(await n(ctx, "SELECT 1 FROM finance_ledger WHERE kind='dues'")).toBe(1);
    expect(duesEvents(log)).toHaveLength(1);
    expect((await ctx.db.query("SELECT state FROM payment_attempts WHERE key='k-crash'"))[0].state).toBe("recorded");
    expect((await verifyConsistency(ctx.db, entries(log))).ok).toBe(true);
  });

  it("a ledger row left without its event (an older run) is repaired by the retry, not just adopted", async () => {
    const { ctx, log, payments, m } = await member();
    // Reconstruct the old failure: the payment was charged and the ledger row exists, but no event and the attempt still says 'charged'.
    await ctx.db.query("INSERT INTO payment_attempts(key,member_id,amount_minor,state,ref,currency,country) VALUES ('k-old',$1,20000,'charged','OLD-1','NGN','NG')", [m.memberId]);
    await ctx.db.query("INSERT INTO finance_ledger(kind,amount_minor,member_id,external_ref,occurred_at) VALUES ('dues',20000,$1,'OLD-1',now())", [m.memberId]);
    expect(await n(ctx, "SELECT 1 FROM log_outbox WHERE type='finance.dues'")).toBe(0);
    const before = await verifyConsistency(ctx.db, entries(log));
    expect(before.problems.join(" ")).toMatch(/no public finance.dues event/); // the checker sees the gap

    expect(await finance.retryUnrecorded(ctx)).toMatchObject({ recorded: 1, stillFailing: 0 });
    await ctx.events.flush();

    expect(await n(ctx, "SELECT 1 FROM finance_ledger WHERE kind='dues'")).toBe(1); // still one row
    const ev = duesEvents(log);
    expect(ev).toHaveLength(1); // the missing event now exists
    expect(ev[0].data).toMatchObject({ amount_minor: 20000, member_ref: logRef(ctx, "member", m.memberId) });
    expect((await ctx.db.query("SELECT state, ledger_id FROM payment_attempts WHERE key='k-old'"))[0].state).toBe("recorded");
    expect(payments.charges).toBe(0); // nobody was charged again
    expect((await verifyConsistency(ctx.db, entries(log))).ok).toBe(true);
    expect(await finance.retryUnrecorded(ctx)).toMatchObject({ recorded: 0 }); // and repairing twice adds nothing
    expect(duesEvents(log)).toHaveLength(1);
  });

  it("an adopted row whose event already exists does not get a second one", async () => {
    const { ctx, log, m } = await member();
    const first = await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-ok");
    await ctx.db.query("UPDATE payment_attempts SET state='charged' WHERE key='k-ok'"); // as if the mark never happened
    expect(await finance.retryUnrecorded(ctx)).toMatchObject({ recorded: 1 });
    expect(duesEvents(log)).toHaveLength(1);
    expect(first.ledgerId).toBeGreaterThan(0);
  });

  it("the checker reports every ledger row's event, and old rows from before the outbox only as notes", async () => {
    const { ctx, log, m } = await member();
    await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-1");
    await ctx.db.query("INSERT INTO finance_ledger(kind,amount_minor,member_id,external_ref,at) VALUES ('dues',10000,$1,'ANCIENT-1', now() - interval '30 days')", [m.memberId]);
    const rep = await verifyConsistency(ctx.db, entries(log));
    expect(rep.ok).toBe(true);
    expect(rep.notes.join(" ")).toMatch(/predates the outbox/);
  });
});
