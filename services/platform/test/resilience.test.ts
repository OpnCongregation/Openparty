import { describe, expect, it } from "vitest";
import { MemoryTrustLog, type LogEvent, type TrustLog } from "../src/adapters.js";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import { Outbox } from "../src/outbox.js";
import { confirmJoin, prepareJoin } from "../src/members.js";
import { createCtx } from "../src/platform.js";
import { PgLimiter } from "../src/ratelimit.js";
import { buildServer } from "../src/server.js";
import { verifyConsistency } from "../src/consistency.js";
import { freshNin, makeAdmin, setup } from "./helpers.js";

/** A log that can be made to fail, like a trust log that is down or a network that drops. */
class FlakyLog implements TrustLog {
  inner = new MemoryTrustLog();
  down = false;
  async append(e: LogEvent) {
    if (this.down) throw new Error("log unreachable");
    return this.inner.append(e);
  }
  get events() { return this.inner.events; }
}

async function flakyCtx() {
  const log = new FlakyLog();
  const ctx = await createCtx({ log });
  return { ctx, log };
}

let nth = 0; // contests may not share a vote date, and these tests only need many events
const vote = (ctx: any) => new Date(ctx.clock().getTime() + (40 + nth++) * DAY);
const mk = (ctx: any, name = "P") => contests.createContest(ctx, { name, primaryType: "direct", mode: "virtual", voteDate: vote(ctx) });
const pendingRows = async (ctx: any) => (await ctx.db.query("SELECT COUNT(*)::int AS n FROM log_outbox WHERE published_at IS NULL"))[0].n as number;

describe("Outbox: the database and the public log cannot disagree", () => {
  it("a change commits even when the log is down, and the event follows once it is back", async () => {
    const { ctx, log } = await flakyCtx();
    log.down = true;
    const id = await mk(ctx); // the call succeeds: the contest is in the database
    expect((await ctx.db.query("SELECT 1 FROM contests WHERE id=$1", [id])).length).toBe(1);
    expect(log.events).toHaveLength(0);
    expect(await pendingRows(ctx)).toBe(1);
    expect((await ctx.events.stats()).lastError).toMatch(/unreachable/);

    log.down = false; // "restart": the background publisher drains what was committed
    await ctx.events.flush();
    expect(log.events.map((e) => e.type)).toEqual(["contest.created"]);
    expect(await pendingRows(ctx)).toBe(0);
    expect((await ctx.events.stats()).lastError).toBeNull();
  });

  it("publishing the same event twice leaves one entry (a crash after the append, before the mark)", async () => {
    const { ctx, log } = await flakyCtx();
    await mk(ctx);
    expect(log.events).toHaveLength(1);
    await ctx.db.query("UPDATE log_outbox SET published_at=NULL"); // as if the mark was never saved
    await ctx.events.flush();
    expect(log.events).toHaveLength(1);
    expect(await pendingRows(ctx)).toBe(0);
  });

  it("an event rolls back with its change: no event without a row", async () => {
    const { ctx, log } = await flakyCtx();
    await expect(ctx.commit(async (tx) => {
      await tx.query("INSERT INTO contests(id,name,primary_type,mode,vote_date) VALUES ('c1','x','direct','virtual',$1)", [vote(ctx).toISOString()]);
      await ctx.events.emit(tx, { type: "contest.opened", data: { contest_id: "3f2b8c1e-5a4d-4e6f-9b1a-0c2d3e4f5a6b" } });
      throw new Error("something later in the transaction failed");
    })).rejects.toThrow("something later");
    expect(await ctx.db.query("SELECT 1 FROM contests WHERE id='c1'")).toHaveLength(0);
    expect(await ctx.db.query("SELECT 1 FROM log_outbox")).toHaveLength(0);
    await ctx.events.flush();
    expect(log.events).toHaveLength(0);
  });

  it("an event that could never be published fails the change instead of waiting in the outbox forever", async () => {
    const { ctx } = await flakyCtx();
    await expect(ctx.commit(async (tx) => {
      await tx.query("INSERT INTO contests(id,name,primary_type,mode,vote_date) VALUES ('c2','x','direct','virtual',$1)", [vote(ctx).toISOString()]);
      await ctx.events.emit(tx, { type: "member.exported", data: { everything: "yes" } });
    })).rejects.toThrow(/allowlist/);
    expect(await ctx.db.query("SELECT 1 FROM contests WHERE id='c2'")).toHaveLength(0);
  });

  it("events reach the log in commit order, even when some attempts fail first", async () => {
    const { ctx, log } = await flakyCtx();
    log.down = true;
    for (let i = 0; i < 4; i++) await mk(ctx, `C${i}`);
    log.down = false;
    await mk(ctx, "C4");
    const names = log.events.map((e) => e.type);
    expect(names).toEqual(Array(5).fill("contest.created"));
    const rows = await ctx.db.query<{ name: string }>("SELECT name FROM contests ORDER BY vote_date, name");
    expect(rows).toHaveLength(5);
    const order = (await ctx.db.query<{ oid: string }>("SELECT oid FROM log_outbox ORDER BY seq")).map((r) => r.oid);
    expect(log.events.map((e) => e.oid)).toEqual(order);
  });

  it("two publishers at once publish every event exactly once", async () => {
    const { ctx, log } = await flakyCtx();
    log.down = true;
    for (let i = 0; i < 6; i++) await mk(ctx, `C${i}`);
    log.down = false;
    const sinkB = new FlakyLog();
    const second = new Outbox(ctx.db, sinkB);
    await Promise.all([ctx.events.flush(), second.flush(), ctx.events.flush(), second.flush()]);
    const total = log.events.length + sinkB.events.length;
    expect(total).toBe(6);
    const oids = [...log.events, ...sinkB.events].map((e) => e.oid);
    expect(new Set(oids).size).toBe(6);
  });

  it("every published event carries its idempotency key and commit time", async () => {
    const { ctx, log } = await flakyCtx();
    await mk(ctx);
    const e = log.events[0];
    expect(e.oid).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(e.at!).toISOString()).toBe(e.at);
  });

  it("an approval's vote, execution and announcement all go through the outbox", async () => {
    const { ctx, log } = await flakyCtx();
    const { approve, propose } = await import("../src/admin.js");
    const sec = await makeAdmin(ctx, "secretary");
    const ec = await makeAdmin(ctx, "electoral_committee");
    log.down = true;
    const id = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 50_000 });
    const r = await approve(ctx, ec, id);
    expect(r.executed).toBe(true);
    expect(log.events.map((e) => e.type)).toEqual(["admin.registered", "admin.registered"]); // only what happened before the outage
    log.down = false;
    await ctx.events.flush();
    expect(log.events.map((e) => e.type)).toEqual(["admin.registered", "admin.registered", "approval.proposed", "approval.voted", "rule.set", "approval.executed"]);
  });
});

describe("Shared rate limits", () => {
  const SECRET = "test-secret-0123456789";
  const post = (app: ReturnType<typeof buildServer>, phone = "+2348000000099") =>
    app.inject({
      method: "POST", url: "/ussd",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-ussd-secret": SECRET },
      payload: `phoneNumber=${encodeURIComponent(phone)}&text=`,
    });
  const opts = { secret: SECRET, perPhone: 4, perIp: 1000, windowMs: 3_600_000 };

  it("two instances on one database share one budget", async () => {
    const { ctx } = await setup();
    const a = buildServer(ctx, { ussd: opts });
    const b = buildServer(ctx, { ussd: opts }); // another process: its own memory, the same database
    const codes = [(await post(a)).statusCode, (await post(b)).statusCode, (await post(a)).statusCode, (await post(b)).statusCode, (await post(a)).statusCode, (await post(b)).statusCode];
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]); // neither instance alone ever saw more than 3
  });

  it("the count survives a restart", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 4; i++) expect((await post(buildServer(ctx, { ussd: opts }))).statusCode).toBe(200);
    const restarted = buildServer(ctx, { ussd: opts }); // fresh memory
    expect((await post(restarted)).statusCode).toBe(429);
    expect((await post(restarted, "+2348000000100")).statusCode).toBe(200); // someone else is unaffected
  });

  it("with shared:false the budget is private to the process (the old behaviour, by choice)", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 4; i++) await post(buildServer(ctx, { ussd: { ...opts, shared: false } }));
    expect((await post(buildServer(ctx, { ussd: { ...opts, shared: false } }))).statusCode).toBe(200);
  });

  it("the weighting is exact", async () => {
    const { ctx } = await setup();
    let now = 5 * 60_000;
    const lim = new PgLimiter(ctx.db, "w", 10, 60_000, () => now);
    for (let i = 0; i < 10; i++) await lim.take("k"); // 10 in the window starting at 5:00 (the 11th would be refused)
    now = 6 * 60_000 + 30_000; // halfway through the next window: previous counts 10 * 0.5 = 5
    // 5 (carried) + n (this window) <= 10  =>  exactly 5 requests fit
    const got: boolean[] = [];
    for (let i = 0; i < 7; i++) got.push(await lim.take("k"));
    expect(got).toEqual([true, true, true, true, true, false, false]);
    now += 2 * 60_000 + 1; // two windows later nothing is carried
    expect(await lim.take("k")).toBe(true);
  });

  it("old windows are deleted", async () => {
    const { ctx } = await setup();
    let now = 0;
    const lim = new PgLimiter(ctx.db, "c", 1_000_000, 1000, () => now);
    for (let i = 0; i < 1000; i++) { now = i * 1000; await lim.take(`k${i % 5}`); }
    await new Promise((r) => setTimeout(r, 50));
    const left = (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM rate_limits"))[0].n;
    expect(left).toBeLessThan(40);
  });
});

describe("Join confirmation is shared state, not process memory", () => {
  const phone = "+2348055512345";

  it("a join started on one instance is confirmed on another", async () => {
    const { ctx } = await setup();
    const nin = freshNin();
    await prepareJoin(ctx, phone, nin);
    const other = { ...ctx }; // a second instance: same database and keys, nothing else in common
    const r = await confirmJoin(other, phone, "anonymous", "1234");
    expect(r.cardNo).toMatch(/^OP-/);
  });

  it("two simultaneous confirmations create exactly one member", async () => {
    const { ctx } = await setup();
    await prepareJoin(ctx, phone, freshNin());
    const res = await Promise.allSettled([confirmJoin(ctx, phone, "anonymous", "1234"), confirmJoin({ ...ctx }, phone, "anonymous", "1234")]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("join_expired");
    expect((await ctx.db.query("SELECT 1 FROM members")).length).toBe(1);
  });

  it("an expired join is refused and purged", async () => {
    const { ctx, advance } = await setup();
    await prepareJoin(ctx, phone, freshNin());
    advance(1); // a day later: well past the 10 minute window
    await expect(confirmJoin(ctx, phone, "anonymous", "1234")).rejects.toMatchObject({ code: "join_expired" });
    await prepareJoin(ctx, "+2348055500001", freshNin()); // any new prepare tidies up expired rows
    const rows = await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM pending_joins");
    expect(rows[0].n).toBe(1);
  });

  it("a mistyped PIN format does not lose the pending join", async () => {
    const { ctx } = await setup();
    await prepareJoin(ctx, phone, freshNin());
    await expect(confirmJoin(ctx, phone, "anonymous", "12")).rejects.toMatchObject({ code: "pin_format" });
    expect((await confirmJoin(ctx, phone, "anonymous", "1234")).cardNo).toMatch(/^OP-/);
  });

  it("the stored state holds no readable personal data", async () => {
    const { ctx } = await setup();
    const nin = freshNin();
    await prepareJoin(ctx, phone, nin);
    const row = (await ctx.db.query<{ phone_hash: string; enc: string }>("SELECT * FROM pending_joins"))[0];
    for (const secret of [nin, phone, "Musa", "Ibrahim", "Market Road", "Kano"]) {
      expect(row.enc).not.toContain(secret);
      expect(row.phone_hash).not.toContain(secret);
    }
  });
});

describe("verify:consistency", () => {
  const asEntries = (events: LogEvent[]) => events.map((e) => Buffer.from(JSON.stringify({ type: e.type, data: e.data, at: e.at, oid: e.oid })));

  it("passes when the database and the log agree", async () => {
    const { ctx, log } = await flakyCtx();
    await mk(ctx); await mk(ctx, "Q");
    const rep = await verifyConsistency(ctx.db, asEntries(log.events));
    expect(rep.problems).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.stats).toMatchObject({ outboxPublished: 2, outboxPending: 0, logEntries: 2 });
  });

  it("finds an event marked published that is not in the log", async () => {
    const { ctx, log } = await flakyCtx();
    await mk(ctx); await mk(ctx, "Q");
    const rep = await verifyConsistency(ctx.db, asEntries(log.events.slice(0, 1)));
    expect(rep.ok).toBe(false);
    expect(rep.problems.join(" ")).toMatch(/marked published but is not in the log/);
  });

  it("finds a log entry nobody committed, and a key used twice", async () => {
    const { ctx, log } = await flakyCtx();
    await mk(ctx);
    const stray = Buffer.from(JSON.stringify({ type: "contest.closed", data: {}, oid: "forged-1" }));
    const dup = asEntries(log.events)[0];
    const rep = await verifyConsistency(ctx.db, [...asEntries(log.events), stray, dup]);
    expect(rep.problems.join(" ")).toMatch(/no matching outbox row/);
    expect(rep.problems.join(" ")).toMatch(/carry the same key/);
  });

  it("finds events stuck unpublished and approvals stuck executing, but not ones that are merely recent", async () => {
    const { ctx, log } = await flakyCtx();
    log.down = true;
    await mk(ctx);
    expect((await verifyConsistency(ctx.db, [])).ok).toBe(true); // just committed: normal
    await ctx.db.query("UPDATE log_outbox SET at = now() - interval '10 minutes'");
    await ctx.db.query("INSERT INTO approvals(id,action,payload,proposer,status,created_at) VALUES ('a1','rule.set','{}','p','executing', now() - interval '10 minutes')");
    const rep = await verifyConsistency(ctx.db, []);
    expect(rep.problems.join(" ")).toMatch(/has waited/);
    expect(rep.problems.join(" ")).toMatch(/stuck in 'executing'/);
  });
});