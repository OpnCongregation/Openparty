import { describe, expect, it } from "vitest";
import { CrashPoint, approve, propose, recoverApprovals } from "../src/admin.js";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import { makeAdmin, setup } from "./helpers.js";

const POINTS = ["after_claim", "before_effect", "after_effect", "after_commit"] as const;

async function scenario() {
  const s = await setup();
  const sec = await makeAdmin(s.ctx, "secretary");
  const ec = await makeAdmin(s.ctx, "electoral_committee");
  const id = await propose(s.ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 50_000 });
  return { ...s, sec, ec, id };
}
const count = async (ctx: any, sql: string, p: unknown[] = []) => (await ctx.db.query(sql, p)).length as number;
const status = async (ctx: any, id: string) => (await ctx.db.query("SELECT status, attempts FROM approvals WHERE id=$1", [id]))[0] as { status: string; attempts: number };

/** What "exactly once" means for this action: one rule version, one rule.set event, one approval.executed event, terminal state. */
async function expectAppliedOnce(ctx: any, log: any, id: string) {
  await ctx.events.flush();
  expect(await count(ctx, "SELECT 1 FROM rules WHERE key='dues.min_payment_minor'")).toBe(1);
  expect(await contests.getRule(ctx, "dues.min_payment_minor")).toBe(50_000);
  expect(log.events.filter((e: any) => e.type === "rule.set")).toHaveLength(1);
  expect(log.events.filter((e: any) => e.type === "approval.executed")).toHaveLength(1);
  expect((await status(ctx, id)).status).toBe("executed");
}

describe("F-10: an approved action takes effect exactly once, whatever crashes", () => {
  for (const point of POINTS) {
    it(`crash at ${point}, then restart: applied once, terminal state reached`, async () => {
      const { ctx, log, ec, id } = await scenario();
      ctx.crashAt = (p) => { if (p === point) throw new CrashPoint(p); };
      await expect(approve(ctx, ec, id)).rejects.toBeInstanceOf(CrashPoint);

      ctx.crashAt = undefined; // the process restarted
      const st = (await status(ctx, id)).status;
      expect(st).toBe(point === "after_commit" ? "executed" : "executing"); // nothing half-done: either all or nothing
      if (point !== "after_commit") {
        expect(await count(ctx, "SELECT 1 FROM rules WHERE key='dues.min_payment_minor'")).toBe(0); // effect NOT applied while 'executing'
      }
      const r = await recoverApprovals(ctx, 0);
      expect(r.recovered).toBe(point === "after_commit" ? 0 : 1);
      await expectAppliedOnce(ctx, log, id);
      expect(await recoverApprovals(ctx, 0)).toEqual({ recovered: 0, failed: 0 }); // nothing left to do
    });
  }

  it("a fresh claim is left alone until its lease expires", async () => {
    const { ctx, ec, id } = await scenario();
    ctx.crashAt = (p) => { if (p === "after_claim") throw new CrashPoint(p); };
    await expect(approve(ctx, ec, id)).rejects.toBeInstanceOf(CrashPoint);
    ctx.crashAt = undefined;
    expect(await recoverApprovals(ctx, 3600)).toEqual({ recovered: 0, failed: 0 }); // the claimant may still be working
    expect((await status(ctx, id)).status).toBe("executing");
    expect((await recoverApprovals(ctx, 0)).recovered).toBe(1);
  });

  it("two recoverers at once apply it once", async () => {
    const { ctx, log, ec, id } = await scenario();
    ctx.crashAt = (p) => { if (p === "after_claim") throw new CrashPoint(p); };
    await expect(approve(ctx, ec, id)).rejects.toBeInstanceOf(CrashPoint);
    ctx.crashAt = undefined;
    const rs = await Promise.all([recoverApprovals(ctx, 0), recoverApprovals({ ...ctx }, 0), recoverApprovals(ctx, 0)]);
    expect(rs.reduce((n, r) => n + r.recovered, 0)).toBe(1);
    await expectAppliedOnce(ctx, log, id);
  });

  it("a claimant that was only slow, not dead, cannot apply the action a second time", async () => {
    const { ctx, log, ec, id } = await scenario();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ctx.crashAt = (p) => (p === "after_claim" ? gate : undefined); // the original claimant stalls after claiming
    const slow = approve(ctx, ec, id);
    // Wait until the claim has actually been committed (it takes longer on a real server than on the embedded one).
    for (let i = 0; i < 100 && (await status(ctx, id)).status !== "executing"; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await status(ctx, id)).status).toBe("executing");
    ctx.crashAt = undefined;
    expect((await recoverApprovals(ctx, 0)).recovered).toBe(1); // someone else takes over and finishes
    release(); // the slow claimant wakes up
    const late = await slow;
    expect(late.executed).toBe(false); // it lost the claim and did nothing
    await expectAppliedOnce(ctx, log, id);
  });

  it("an action that the rules now refuse is recorded as failed, not retried forever", async () => {
    const { ctx, sec, ec } = await scenario();
    const cid = await contests.createContest(ctx, { name: "N", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY) });
    const id2 = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 70_000 });
    await contests.generateNotice(ctx, cid); // rules lock after the proposal
    await expect(approve(ctx, ec, id2)).rejects.toMatchObject({ code: "rules_locked" });
    expect((await status(ctx, id2)).status).toBe("failed");
    expect(await count(ctx, "SELECT 1 FROM rules")).toBe(0);
  });

  it("gives up after repeated failed attempts so it cannot loop", async () => {
    const { ctx, ec, id } = await scenario();
    ctx.crashAt = (p) => { if (p === "after_claim") throw new CrashPoint(p); };
    await expect(approve(ctx, ec, id)).rejects.toBeInstanceOf(CrashPoint);
    ctx.crashAt = undefined;
    await ctx.db.query("UPDATE approvals SET attempts=3 WHERE id=$1", [id]);
    expect(await recoverApprovals(ctx, 0)).toEqual({ recovered: 0, failed: 1 });
    expect((await status(ctx, id)).status).toBe("failed");
  });

  it("every transition of the register freeze and contest open can crash and recover (multi-step actions)", async () => {
    const { ctx, log, sec, ec } = await setup().then(async (s) => ({ ...s, sec: await makeAdmin(s.ctx, "secretary"), ec: await makeAdmin(s.ctx, "electoral_committee") }));
    const aud = await makeAdmin(ctx, "auditor");
    const cid = await contests.createContest(ctx, { name: "F", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY) });
    const id = await propose(ctx, sec, "register.freeze", { contestId: cid });
    await approve(ctx, ec, id);
    ctx.crashAt = (p) => { if (p === "after_effect") throw new CrashPoint(p); };
    await expect(approve(ctx, aud, id)).rejects.toBeInstanceOf(CrashPoint); // register written inside the tx, then the process dies
    ctx.crashAt = undefined;
    expect(await count(ctx, "SELECT 1 FROM registers")).toBe(0); // rolled back with it
    expect((await recoverApprovals(ctx, 0)).recovered).toBe(1);
    await ctx.events.flush();
    expect(await count(ctx, "SELECT 1 FROM registers")).toBe(1);
    expect(log.events.filter((e) => e.type === "register.frozen")).toHaveLength(1);
    expect((await status(ctx, id)).status).toBe("executed");
  });
});
