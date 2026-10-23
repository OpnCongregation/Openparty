import { describe, expect, it } from "vitest";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import { handleUssd } from "../src/ussd.js";
import { completeRecord, notifyExcluded, sendRecordNotices } from "../src/record-notices.js";
import { joinAndActivate, makeAdmin, setup } from "./helpers.js";

async function world(contestInDays: number | null = 40) {
  const s = await setup();
  const agent = await makeAdmin(s.ctx, "ward_agent", "W1");
  const good = await joinAndActivate(s.ctx, agent);
  const bad = await joinAndActivate(s.ctx, agent);
  const rec = await s.ctx.keys.decrypt<any>(bad.memberId, (await s.ctx.db.query<any>("SELECT record_enc FROM members WHERE id=$1", [bad.memberId]))[0].record_enc);
  rec.polling_unit = ""; rec.address = "";
  await s.ctx.db.query("UPDATE members SET record_enc=$2 WHERE id=$1", [bad.memberId, await s.ctx.keys.encrypt(bad.memberId, rec)]);
  let cid = "";
  if (contestInDays !== null) {
    cid = await contests.createContest(s.ctx, { name: "P", primaryType: "direct", mode: "virtual", voteDate: new Date(s.ctx.clock().getTime() + contestInDays * DAY) });
    await contests.generateNotice(s.ctx, cid);
  }
  const texts = (phone: string) => s.sms.outbox.filter((m) => m.phone === phone).map((m) => m.text);
  return { ...s, agent, good, bad, cid, texts };
}

describe("appeal period: notices about incomplete records", () => {
  it("tells only the incomplete member, names what is missing and gives the filing date", async () => {
    const { ctx, bad, good, texts, state } = await world();
    const before = texts(good.phone).length;
    expect(await sendRecordNotices(ctx)).toEqual({ sent: 1, failed: 0 });
    const due = new Date(state.now.getTime() + 19 * DAY).toISOString().slice(0, 10); // 40 days to vote, 21-day filing rule
    const msg = texts(bad.phone).at(-1)!;
    expect(msg).toContain("address, polling unit");
    expect(msg).toContain(due);
    expect(texts(good.phone)).toHaveLength(before); // complete members are left alone
    expect(await sendRecordNotices(ctx)).toEqual({ sent: 0, failed: 0 }); // not again the same day
  });

  it("without a contest the notice carries no date and is sent once", async () => {
    const { ctx, bad, texts, advance } = await world(null);
    await sendRecordNotices(ctx);
    expect(texts(bad.phone).at(-1)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    advance(30);
    expect((await sendRecordNotices(ctx)).sent).toBe(0);
  });

  it("reminds weekly, then 3 days and 1 day before the deadline, then stops when the deadline passes", async () => {
    const { ctx, advance } = await world(); // deadline in 19 days
    const run = async (days: number) => { advance(days); return (await sendRecordNotices(ctx)).sent; };
    expect(await sendRecordNotices(ctx)).toEqual({ sent: 1, failed: 0 }); // day 0
    expect(await run(3)).toBe(0);  // day 3
    expect(await run(4)).toBe(1);  // day 7: weekly
    expect(await run(5)).toBe(0);  // day 12
    expect(await run(2)).toBe(1);  // day 14: weekly
    expect(await run(2)).toBe(1);  // day 16: 3 days left
    expect(await run(1)).toBe(0);  // day 17: 2 days left, nothing new
    expect(await run(1)).toBe(1);  // day 18: 1 day left
    expect(await run(0)).toBe(0);
    expect(await run(2)).toBe(0);  // day 20: the deadline (day 19) has passed
  });

  it("a failed SMS is retried on the next run", async () => {
    const { ctx, sms, texts, bad } = await world();
    const send = sms.send.bind(sms);
    sms.send = async () => { throw new Error("gateway down"); };
    expect(await sendRecordNotices(ctx)).toEqual({ sent: 0, failed: 1 });
    sms.send = send;
    expect(await sendRecordNotices(ctx)).toEqual({ sent: 1, failed: 0 });
    expect(texts(bad.phone).at(-1)).toContain("incomplete");
  });

  it("two runs at once send one notice", async () => {
    const { ctx } = await world();
    const rs = await Promise.all([sendRecordNotices(ctx), sendRecordNotices(ctx), sendRecordNotices(ctx)]);
    expect(rs.reduce((n, r) => n + r.sent, 0)).toBe(1);
  });
});

describe("appeal period: filing without the incomplete records", () => {
  it("is refused until each member has been told and has had 7 days", async () => {
    const { ctx, cid, advance } = await world();
    await expect(contests.freezeRegister(ctx, cid, { excludeIncomplete: true })).rejects.toMatchObject({ code: "appeal_open" }); // never notified
    await sendRecordNotices(ctx); advance(3);
    await expect(contests.freezeRegister(ctx, cid, { excludeIncomplete: true })).rejects.toMatchObject({ code: "appeal_open" }); // too soon
    advance(5);
    expect(await contests.freezeRegister(ctx, cid, { excludeIncomplete: true })).toMatchObject({ memberCount: 1, excludedCount: 1 });
  });

  it("short notice does not make the deadline impossible: inside the last day the complete records can be filed", async () => {
    const { ctx, cid, advance } = await world();
    advance(18.5); await sendRecordNotices(ctx); // first notice only 12 hours before the deadline
    expect((await contests.freezeRegister(ctx, cid, { excludeIncomplete: true })).excludedCount).toBe(1);
  });

  it("tells the left-off member once; they cannot vote in this contest", async () => {
    const { ctx, cid, advance, texts, bad } = await world();
    await sendRecordNotices(ctx); advance(8);
    const f = await contests.freezeRegister(ctx, cid, { excludeIncomplete: true });
    const filed = () => texts(bad.phone).filter((x) => x.includes("filed without you")).length;
    expect(filed()).toBe(1);
    await notifyExcluded(ctx, f.registerId, [{ memberId: bad.memberId, phone: bad.phone }]);
    expect(filed()).toBe(1);
    expect(await contests.isEligible(ctx, cid, bad.memberId)).toBe(false);
  });
});

describe("appeal period: completing the record (no screen)", () => {
  it("by USSD option 4: asks for each missing field, saves them, and the member is then complete", async () => {
    const { ctx, bad, log, cid } = await world();
    expect(await handleUssd(ctx, bad.phone, "")).toContain("4 Complete my record");
    expect(await handleUssd(ctx, bad.phone, "4")).toMatch(/PIN/);
    expect(await handleUssd(ctx, bad.phone, "4*1234")).toBe("CON Enter your address:");
    expect(await handleUssd(ctx, bad.phone, "4*1234*12 Market Road")).toBe("CON Enter your polling unit:");
    expect(await handleUssd(ctx, bad.phone, "4*1234*12 Market Road*PU-042")).toMatch(/^END Thank you/);
    await ctx.events.flush();
    const rec = await ctx.keys.decrypt<any>(bad.memberId, (await ctx.db.query<any>("SELECT record_enc FROM members WHERE id=$1", [bad.memberId]))[0].record_enc);
    expect(rec).toMatchObject({ polling_unit: "PU-042", address: "12 Market Road" });
    const ev = log.events.find((e: any) => e.type === "member.record_completed")!;
    expect(JSON.stringify(ev.data)).not.toMatch(/PU-042|Market/); // the log says it happened, never what was said
    expect(await handleUssd(ctx, bad.phone, "4*1234")).toMatch(/complete/);
    expect(await sendRecordNotices(ctx)).toEqual({ sent: 0, failed: 0 });
    expect((await contests.freezeRegister(ctx, cid)).memberCount).toBe(2); // nothing left to exclude
  });

  it("a wrong PIN gets nothing; a member cannot supply a photo or overwrite a filled field", async () => {
    const { ctx, bad } = await world();
    expect(await handleUssd(ctx, bad.phone, "4*9999")).toMatch(/^END/);
    await expect(completeRecord(ctx, bad.memberId, { photo: "x" }, { self: true })).rejects.toMatchObject({ code: "field_not_allowed" });
    await expect(completeRecord(ctx, bad.memberId, { state: "Lagos" }, { self: true })).rejects.toMatchObject({ code: "already_set" });
    await expect(completeRecord(ctx, bad.memberId, { address: "a*b" }, { self: true })).rejects.toMatchObject({ code: "bad_value" });
  });

  it("a ward agent can supply the rest, for a member of their own ward only", async () => {
    const { ctx, bad, agent } = await world();
    const other = await makeAdmin(ctx, "ward_agent", "W2");
    const sec = await makeAdmin(ctx, "secretary");
    await expect(completeRecord(ctx, bad.memberId, { address: "x" }, { agent: other })).rejects.toMatchObject({ code: "wrong_ward" });
    await expect(completeRecord(ctx, bad.memberId, { address: "x" }, { agent: sec })).rejects.toMatchObject({ code: "forbidden" });
    await expect(completeRecord(ctx, bad.memberId, { national_id: "1" }, { agent })).rejects.toMatchObject({ code: "field_not_allowed" });
    expect(await completeRecord(ctx, bad.memberId, { address: "5 Hill St" }, { agent })).toEqual({ remaining: ["polling_unit"] });
    expect(await completeRecord(ctx, bad.memberId, { polling_unit: "PU-9" }, { agent })).toEqual({ remaining: [] });
  });
});
