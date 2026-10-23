import { describe, expect, it } from "vitest";
import { approve, propose } from "../src/admin.js";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import { erase, resign } from "../src/members.js";
import { joinAndActivate, makeAdmin, setup } from "./helpers.js";

async function noticed() {
  const s = await setup();
  const agent = await makeAdmin(s.ctx, "ward_agent", "W1");
  const sec = await makeAdmin(s.ctx, "secretary");
  const ec = await makeAdmin(s.ctx, "electoral_committee");
  const aud = await makeAdmin(s.ctx, "auditor");
  const ms = [await joinAndActivate(s.ctx, agent), await joinAndActivate(s.ctx, agent), await joinAndActivate(s.ctx, agent)];
  const cid = await contests.createContest(s.ctx, { name: "P", primaryType: "direct", mode: "virtual", voteDate: new Date(s.ctx.clock().getTime() + 40 * DAY) });
  await contests.generateNotice(s.ctx, cid);
  await contests.recordNoticeReceipt(s.ctx, cid, "INEC-N-001");
  return { ...s, agent, sec, ec, aud, ms, cid };
}

describe("election gates", () => {
  it("opening and closing wait for the vote date and are approved by two others", async () => {
    const { ctx, advance, sec, ec, aud, cid } = await noticed();
    const f = await contests.freezeRegister(ctx, cid);
    await contests.recordRegisterReceipt(ctx, f.registerId, "INEC-R-001");
    await expect(contests.openContest(ctx, cid)).rejects.toMatchObject({ code: "too_early" });
    advance(40);
    const o = await propose(ctx, ec, "contest.open", { contestId: cid });
    await approve(ctx, sec, o); await approve(ctx, aud, o);
    expect((await ctx.db.query<any>("SELECT state FROM contests WHERE id=$1", [cid]))[0].state).toBe("open");
    await expect(contests.openContest(ctx, cid)).rejects.toMatchObject({ code: "already_open" });
    // closing is an approved action too: the secretary cannot propose it, and one approval is not enough
    await expect(propose(ctx, sec, "contest.close", { contestId: cid })).rejects.toMatchObject({ code: "forbidden" });
    const c = await propose(ctx, ec, "contest.close", { contestId: cid });
    await approve(ctx, sec, c);
    expect((await ctx.db.query<any>("SELECT state FROM contests WHERE id=$1", [cid]))[0].state).toBe("open");
    await approve(ctx, aud, c);
    expect((await ctx.db.query<any>("SELECT state FROM contests WHERE id=$1", [cid]))[0].state).toBe("closed");
    await expect(contests.openContest(ctx, cid)).rejects.toMatchObject({ code: "already_closed" });
    await expect(contests.closeContest(ctx, cid)).rejects.toMatchObject({ code: "already_closed" });
  });

  it("a contest cannot be closed before the vote date", async () => {
    const { ctx, advance, state, cid } = await noticed();
    const f = await contests.freezeRegister(ctx, cid);
    await contests.recordRegisterReceipt(ctx, f.registerId, "INEC-R-001");
    advance(40); await contests.openContest(ctx, cid);
    state.now = new Date(state.now.getTime() - 2 * DAY); // clock error
    await expect(contests.closeContest(ctx, cid)).rejects.toMatchObject({ code: "too_early" });
  });

  it("receipt references must look like references", async () => {
    const { ctx, cid } = await noticed();
    const c2 = await contests.createContest(ctx, { name: "Q", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 50 * DAY) });
    await contests.generateNotice(ctx, c2);
    for (const bad of ["x", "12345", "has space in it", "<script>", "a".repeat(65), "  "]) {
      await expect(contests.recordNoticeReceipt(ctx, c2, bad)).rejects.toMatchObject({ code: expect.stringMatching(/bad_receipt|receipt_required/) });
    }
    await contests.recordNoticeReceipt(ctx, c2, "  INEC/2026/N-77  ");
    expect((await ctx.db.query<any>("SELECT notice_receipt FROM contests WHERE id=$1", [c2]))[0].notice_receipt).toBe("INEC/2026/N-77"); // trimmed
    const f = await contests.freezeRegister(ctx, cid);
    await expect(contests.recordRegisterReceipt(ctx, f.registerId, "x")).rejects.toMatchObject({ code: "bad_receipt" });
  });

  it("two open contests cannot share a vote date, but a closed one frees the date", async () => {
    const { ctx, cid } = await noticed();
    const same = (await ctx.db.query<any>("SELECT vote_date FROM contests WHERE id=$1", [cid]))[0].vote_date;
    await expect(contests.createContest(ctx, { name: "Dup", primaryType: "direct", mode: "virtual", voteDate: new Date(same) })).rejects.toMatchObject({ code: "contest_overlap" });
    await ctx.db.query("UPDATE contests SET state='closed' WHERE id=$1", [cid]);
    await expect(contests.createContest(ctx, { name: "Again", primaryType: "direct", mode: "virtual", voteDate: new Date(same) })).resolves.toEqual(expect.any(String));
  });

  it("freezing reports every incomplete record at once", async () => {
    const { ctx, cid, ms } = await noticed();
    for (const m of ms.slice(0, 2)) {
      const rec = await ctx.keys.decrypt<any>(m.memberId, (await ctx.db.query<any>("SELECT record_enc FROM members WHERE id=$1", [m.memberId]))[0].record_enc);
      rec.polling_unit = "";
      await ctx.db.query("UPDATE members SET record_enc=$2 WHERE id=$1", [m.memberId, await ctx.keys.encrypt(m.memberId, rec)]);
    }
    const err: any = await contests.freezeRegister(ctx, cid).catch((e) => e);
    expect(err.code).toBe("incomplete_record");
    expect(err.message).toMatch(/^2 member record/);
  });

  it("eligibility: on the frozen register and still an active member", async () => {
    const { ctx, cid, ms } = await noticed();
    await contests.freezeRegister(ctx, cid);
    expect(await contests.isEligible(ctx, cid, ms[0].memberId)).toBe(true);
    await resign(ctx, ms[1].memberId);
    expect(await contests.isEligible(ctx, cid, ms[1].memberId)).toBe(false); // resigned after the freeze: on the filed register, but cannot vote
    await expect(erase(ctx, ms[2].memberId)).rejects.toThrow(/live contest register/); // erasure is already refused while a register is live
    expect(await contests.isEligible(ctx, cid, ms[2].memberId)).toBe(true);
    expect(await contests.isEligible(ctx, cid, "nobody")).toBe(false);
  });
});
