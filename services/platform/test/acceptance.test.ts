import { loadDefaultConfig } from "../src/framework/config.js";
import { describe, expect, it } from "vitest";
import { ROLES, approve, can, propose } from "../src/admin.js";
import { assertNoPersonalData } from "../src/adapters.js";
import * as contests from "../src/contests.js";
import { ErasedError } from "../src/crypto.js";
import { DAY } from "../src/context.js";
import * as finance from "../src/finance.js";
import * as members from "../src/members.js";
import * as participation from "../src/participation.js";
import { handleUssd } from "../src/ussd.js";
import { buildServer } from "../src/server.js";
import { freshNin, joinAndActivate, makeAdmin, setup } from "./helpers.js";

const NGN = (n: number) => ({ ref: `r-${Math.random()}`, amountMinor: n * 100, currency: "NGN", country: "NG" });
const donor = { name: "Chief A", address: "1 Lagos Rd", occupation: "Trader" };

describe("s.77(2) register fields / s.77(3) card", () => {
  it("activation requires every register field and a card number", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const nin = freshNin();
    await members.prepareJoin(ctx, "+2348000000001", nin);
    const j = await members.confirmJoin(ctx, "+2348000000001", "visible", "1234");
    expect(j.cardNo).toMatch(/^OP-/);
    await expect(members.activateMember(ctx, agent, { memberId: j.memberId, ward: "W1", pollingUnit: "", photoRef: "p", disabilityStatus: "none" }))
      .rejects.toMatchObject({ code: "incomplete_record" });
  });

  it("database refuses an active member without a card", async () => {
    const { ctx } = await setup();
    await expect(ctx.db.query("INSERT INTO members(id,id_hash,state) VALUES ('x','h','active')")).rejects.toThrow();
  });

  it("only a ward agent in the member's own ward can activate", async () => {
    const { ctx } = await setup();
    const a1 = await makeAdmin(ctx, "ward_agent", "W1");
    const sec = await makeAdmin(ctx, "secretary");
    await members.prepareJoin(ctx, "+2348000000002", freshNin());
    const j = await members.confirmJoin(ctx, "+2348000000002", "anonymous", "1234");
    const input = { memberId: j.memberId, ward: "W2", pollingUnit: "PU", photoRef: "p", disabilityStatus: "none" };
    await expect(members.activateMember(ctx, a1, input)).rejects.toMatchObject({ code: "wrong_ward" });
    await expect(members.activateMember(ctx, sec, { ...input, ward: "W1" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("one NIN, one member (Infiltration wave)", () => {
  it("rejects a second membership on the same NIN", async () => {
    const { ctx } = await setup();
    const nin = freshNin();
    await members.prepareJoin(ctx, "+2348000000003", nin);
    await members.confirmJoin(ctx, "+2348000000003", "anonymous", "1234");
    await expect(members.prepareJoin(ctx, "+2348000000004", nin)).rejects.toMatchObject({ code: "id_in_use" });
  });
  it("rejects an unverifiable NIN", async () => {
    const { ctx } = await setup();
    await expect(members.prepareJoin(ctx, "+2348000000005", "00000000000")).rejects.toMatchObject({ code: "id_invalid" });
  });
});

describe("PIN lockout", () => {
  it("locks after 5 wrong attempts", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    for (let i = 0; i < 5; i++) await expect(members.verifyPin(ctx, m.phone, "9999")).rejects.toMatchObject({ code: "pin_wrong" });
    await expect(members.verifyPin(ctx, m.phone, "1234")).rejects.toMatchObject({ code: "pin_locked" });
  });
});

describe("Erasure by crypto-shredding (NDPA)", () => {
  it("destroying the key makes the record unreadable while the row and log remain", async () => {
    const { ctx, log } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const before = (await ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.memberId]))[0].record_enc;
    expect((await ctx.keys.decrypt(m.memberId, before)).national_id).toBe(m.nin);
    await members.erase(ctx, m.memberId);
    await expect(ctx.keys.decrypt(m.memberId, before)).rejects.toBeInstanceOf(ErasedError);
    const row = (await ctx.db.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [m.memberId]))[0];
    expect(row.state).toBe("erased");
    expect(log.events.some((e) => e.type === "member.erased")).toBe(true);
  });

  it("blocked while the member is on a live contest register", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const cid = await contests.createContest(ctx, { name: "P", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY) });
    await contests.freezeRegister(ctx, cid);
    await expect(members.erase(ctx, m.memberId)).rejects.toMatchObject({ code: "legal_hold" });
  });
});

describe("No personal data on the public log", () => {
  it("refuses personal keys", () => {
    for (const k of ["name", "nin", "phone", "address", "photo", "dob", "memberName"])
      expect(() => assertNoPersonalData({ [k]: "x" })).toThrow();
    expect(() => assertNoPersonalData({ member_ref: "abc", fingerprint: "f" })).not.toThrow();
  });
  it("a full join/activate/pay cycle puts no identity strings on the log", async () => {
    const { ctx, log } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const p = await ctx.payments.charge(m.phone, 20_000);
    await finance.recordDues(ctx, m.memberId, p);
    const dump = JSON.stringify(log.events);
    for (const secret of [m.nin, m.phone, "Musa Ibrahim", "Market Road"]) expect(dump).not.toContain(secret);
  });
});

describe("s.82(1), Reg 22(1) 21-day notice; Reg 10(2) mode", () => {
  it("notice is refused inside 21 days and issued outside", async () => {
    const { ctx } = await setup();
    const late = await contests.createContest(ctx, { name: "L", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 20 * DAY) });
    await expect(contests.generateNotice(ctx, late)).rejects.toMatchObject({ code: "notice_late" });
    const ok = await contests.createContest(ctx, { name: "O", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 22 * DAY) });
    await expect(contests.generateNotice(ctx, ok)).resolves.toMatchObject({ mode: "virtual" });
  });
  it("a contest cannot exist without a mode", async () => {
    const { ctx } = await setup();
    await expect(contests.createContest(ctx, { name: "x", primaryType: "direct", mode: undefined as any, voteDate: new Date() }))
      .rejects.toMatchObject({ code: "mode_required" });
  });
});

describe("Reg 24(3) primary type lock", () => {
  it("cannot change type at T-3, can at T-4", async () => {
    const { ctx, advance } = await setup();
    const cid = await contests.createContest(ctx, { name: "T", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 30 * DAY) });
    advance(26);
    await expect(contests.changePrimaryType(ctx, cid, "consensus")).resolves.toBeUndefined();
    advance(1);
    await expect(contests.changePrimaryType(ctx, cid, "direct")).rejects.toMatchObject({ code: "type_locked" });
  });
});

describe("Register freeze and contest gate (s.77(4)-(7))", () => {
  async function ready() {
    const s = await setup();
    const agent = await makeAdmin(s.ctx, "ward_agent", "W1");
    await joinAndActivate(s.ctx, agent);
    await joinAndActivate(s.ctx, agent);
    const cid = await contests.createContest(s.ctx, { name: "P", primaryType: "direct", mode: "virtual", voteDate: new Date(s.ctx.clock().getTime() + 40 * DAY) });
    return { ...s, cid };
  }

  it("freeze exports exactly the required fields and posts the fingerprint", async () => {
    const { ctx, log, cid } = await ready();
    const f = await contests.freezeRegister(ctx, cid);
    expect(f.memberCount).toBe(2);
    const exp = await contests.exportRegister(ctx, f.registerId);
    expect(contests.validateRegisterExport(exp.document as any, ctx.config.get("register.fields"))).toEqual([]);
    expect(log.events.find((e) => e.type === "register.frozen")!.data.fingerprint).toBe(f.fingerprint);
    // phone is not a register field and must not appear in the INEC export
    expect(JSON.stringify(exp.document)).not.toContain("+23480");
  });

  it("validator flags a missing field", () => {
    expect(contests.validateRegisterExport({ members: [{ name: "A" }] }, loadDefaultConfig().get("register.fields")).length).toBeGreaterThan(5);
  });

  it("register cannot be frozen inside 21 days", async () => {
    const { ctx, advance, cid } = await ready();
    advance(20);
    await expect(contests.freezeRegister(ctx, cid)).rejects.toMatchObject({ code: "register_late" });
  });

  it("contest cannot open without notice receipt, register, and register receipt", async () => {
    const { ctx, cid } = await ready();
    await contests.generateNotice(ctx, cid);
    await expect(contests.openContest(ctx, cid)).rejects.toMatchObject({ code: "no_notice_receipt" });
    await contests.recordNoticeReceipt(ctx, cid, "INEC-N-1");
    await expect(contests.openContest(ctx, cid)).rejects.toMatchObject({ code: "no_register" });
    const f = await contests.freezeRegister(ctx, cid);
    await expect(contests.openContest(ctx, cid)).rejects.toMatchObject({ code: "no_register_receipt" });
    await contests.recordRegisterReceipt(ctx, f.registerId, "INEC-R-1");
    await expect(contests.openContest(ctx, cid)).resolves.toBeUndefined();
  });

  it("a member activated after the freeze is not on that register", async () => {
    const { ctx, cid } = await ready();
    const f = await contests.freezeRegister(ctx, cid);
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    await joinAndActivate(ctx, agent);
    expect((await contests.exportRegister(ctx, f.registerId)).document).toMatchObject({ members: expect.any(Array) });
    expect(((await contests.exportRegister(ctx, f.registerId)).document as any).members).toHaveLength(2);
  });

  it("tampering with the stored register is detected", async () => {
    const { ctx, cid } = await ready();
    const f = await contests.freezeRegister(ctx, cid);
    await ctx.db.query("UPDATE registers SET fingerprint='deadbeef' WHERE id=$1", [f.registerId]);
    await expect(contests.exportRegister(ctx, f.registerId)).rejects.toMatchObject({ code: "integrity" });
  });
});

describe("Rules lock once a notice is out", () => {
  it("setRule works before notice and fails after, until the contest closes", async () => {
    const { ctx } = await setup();
    await contests.setRule(ctx, "dues.min_payment_minor", 20_000, "sec");
    expect(await contests.getRule(ctx, "dues.min_payment_minor")).toBe(20_000);
    const cid = await contests.createContest(ctx, { name: "R", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 30 * DAY) });
    await contests.generateNotice(ctx, cid);
    await expect(contests.setRule(ctx, "dues.min_payment_minor", 1, "sec")).rejects.toMatchObject({ code: "rules_locked" });
  });
  it("rule history is append-only at the database level", async () => {
    const { ctx } = await setup();
    await contests.setRule(ctx, "dues.min_payment_minor", 20_000, "sec");
    await expect(ctx.db.query("UPDATE rules SET value='1'")).rejects.toThrow(/immutable/);
    await expect(ctx.db.query("DELETE FROM rules")).rejects.toThrow(/immutable/);
  });
  it("has no rule that could add aspirant criteria (s.85)", async () => {
    const { ctx } = await setup();
    for (const k of ["min_membership_months", "aspirant_exam_score", "covenant_score_min", "min_rating"])
      await expect(contests.setRule(ctx, k, 1, "sec")).rejects.toMatchObject({ code: "unknown_rule" });
  });
  it("donor cap cannot be set above the legal N500m", async () => {
    const { ctx } = await setup();
    await expect(contests.setRule(ctx, "finance.cap_per_donor_minor", 500_000_001 * 100, "sec")).rejects.toMatchObject({ code: "invalid_rule" });
  });
});

describe("Finance: s.94, s.89, Reg 44", () => {
  it("anonymous gift rejected", async () => {
    const { ctx } = await setup();
    await expect(finance.recordGift(ctx, NGN(1000), { name: "", address: "x", occupation: "y" })).rejects.toMatchObject({ code: "anonymous_gift" });
    await expect(finance.recordGift(ctx, NGN(1000), undefined as any)).rejects.toMatchObject({ code: "anonymous_gift" });
  });
  it("foreign payment refused and quarantined", async () => {
    const { ctx } = await setup();
    await expect(finance.recordGift(ctx, { ...NGN(1000), country: "US" }, donor)).rejects.toMatchObject({ code: "foreign_funds" });
    await expect(finance.recordGift(ctx, { ...NGN(1000), currency: "USD" }, donor)).rejects.toMatchObject({ code: "foreign_funds" });
    expect((await ctx.db.query("SELECT 1 FROM quarantine")).length).toBe(2);
    expect((await ctx.db.query("SELECT 1 FROM finance_ledger")).length).toBe(0);
  });
  it("per-donor cap is cumulative and never exceeds the legal ceiling", async () => {
    const { ctx } = await setup();
    await contests.setRule(ctx, "finance.cap_per_donor_minor", 100_000_000, "sec"); // N1m
    await finance.recordGift(ctx, NGN(600_000), donor);
    await expect(finance.recordGift(ctx, NGN(500_000), donor)).rejects.toMatchObject({ code: "over_cap" });
    await expect(finance.recordGift(ctx, NGN(400_000), donor)).resolves.toBeDefined();
    await expect(finance.recordGift(ctx, NGN(1), { ...donor, name: "Other" })).resolves.toBeDefined();
  });
  it("default party cap is far below the legal cap", async () => {
    const { ctx } = await setup();
    await expect(finance.recordGift(ctx, NGN(500_000_000), donor)).rejects.toMatchObject({ code: "over_cap" });
  });
  it("duplicate payment reference rejected", async () => {
    const { ctx } = await setup();
    const p = NGN(1000);
    await finance.recordGift(ctx, p, donor);
    await expect(finance.recordGift(ctx, p, { ...donor, name: "B" })).rejects.toMatchObject({ code: "duplicate_payment" });
  });
  it("ledger is immutable and report reconciles", async () => {
    const { ctx } = await setup();
    await finance.recordGift(ctx, NGN(1000), donor);
    await finance.recordGift(ctx, NGN(2000), { ...donor, name: "B" });
    await expect(ctx.db.query("UPDATE finance_ledger SET amount_minor=1")).rejects.toThrow(/immutable/);
    await expect(ctx.db.query("DELETE FROM finance_ledger")).rejects.toThrow(/immutable/);
    const r = await finance.reconcile(ctx);
    expect(r.reconciled).toBe(true);
    expect(r.byKind.gift.totalMinor).toBe(300_000);
    expect(await finance.donorReport(ctx)).toHaveLength(2);
  });
  it("donor identity is not stored in the clear and not on the log", async () => {
    const { ctx, log } = await setup();
    await finance.recordGift(ctx, NGN(1000), donor);
    const row = (await ctx.db.query<{ donor_enc: string }>("SELECT donor_enc FROM finance_ledger"))[0];
    expect(row.donor_enc).not.toContain("Chief");
    expect(JSON.stringify(log.events)).not.toContain("Chief");
  });
  it("dues need a current member and meet the minimum", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    await expect(finance.recordDues(ctx, m.memberId, NGN(1))).rejects.toMatchObject({ code: "dues_too_low" });
    await expect(finance.recordDues(ctx, m.memberId, NGN(100))).resolves.toBeDefined();
    await members.resign(ctx, m.memberId);
    await expect(finance.recordDues(ctx, m.memberId, NGN(100))).rejects.toMatchObject({ code: "not_member" });
  });
});

describe("Separation of powers: admin and approvals", () => {
  it("no security role and no super admin", () => {
    expect(ROLES.some((r) => /secur|super|root|god/i.test(r))).toBe(false);
    const all = ["contest.create", "notice.generate", "receipt.record", "approval.propose", "approval.approve", "gift.record", "finance.report", "register.read", "member.activate"];
    for (const role of ROLES) expect(all.every((p) => can({ id: "", name: "", role, ward: null }, p))).toBe(false);
  });
  it("rule change needs a second person; proposer cannot self-approve", async () => {
    const { ctx } = await setup();
    const sec = await makeAdmin(ctx, "secretary");
    const ec = await makeAdmin(ctx, "electoral_committee");
    const id = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 50_000 });
    await expect(approve(ctx, sec, id)).rejects.toMatchObject({ code: "self_approval" });
    expect(await contests.getRule(ctx, "dues.min_payment_minor")).toBe(10_000);
    const r = await approve(ctx, ec, id);
    expect(r.executed).toBe(true);
    expect(await contests.getRule(ctx, "dues.min_payment_minor")).toBe(50_000);
  });
  it("register freeze needs two approvers from different people", async () => {
    const { ctx } = await setup();
    const sec = await makeAdmin(ctx, "secretary");
    const ec = await makeAdmin(ctx, "electoral_committee");
    const aud = await makeAdmin(ctx, "auditor");
    const cid = await contests.createContest(ctx, { name: "F", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY) });
    const id = await propose(ctx, sec, "register.freeze", { contestId: cid });
    expect((await approve(ctx, ec, id)).executed).toBe(false);
    expect((await approve(ctx, ec, id)).executed).toBe(false); // same person twice still counts once
    expect((await approve(ctx, aud, id)).executed).toBe(true);
  });
  it("wrong roles cannot propose or approve", async () => {
    const { ctx } = await setup();
    const tre = await makeAdmin(ctx, "treasurer");
    const sec = await makeAdmin(ctx, "secretary");
    await expect(propose(ctx, tre, "rule.set", {})).rejects.toMatchObject({ code: "forbidden" });
    const id = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 1 });
    await expect(approve(ctx, tre, id)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("a locked rule cannot be changed even with full approval", async () => {
    const { ctx } = await setup();
    const sec = await makeAdmin(ctx, "secretary");
    const ec = await makeAdmin(ctx, "electoral_committee");
    const cid = await contests.createContest(ctx, { name: "L", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 30 * DAY) });
    await contests.generateNotice(ctx, cid);
    const id = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 1 });
    await expect(approve(ctx, ec, id)).rejects.toMatchObject({ code: "rules_locked" });
  });
});

describe("Participation: petitions reach formal consideration", () => {
  it("threshold queues the proposal with a deadline; one signature each; counts only", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const ms = [] as string[];
    for (let i = 0; i < 3; i++) ms.push((await joinAndActivate(ctx, agent)).memberId);
    const pid = await participation.createProposal(ctx, ms[0], "Open books", "Publish budget", 3);
    await participation.signProposal(ctx, ms[0], pid);
    await expect(participation.signProposal(ctx, ms[0], pid)).rejects.toMatchObject({ code: "already_signed" });
    await participation.signProposal(ctx, ms[1], pid);
    expect((await participation.proposalStatus(ctx, pid)).status).toBe("open");
    const r = await participation.signProposal(ctx, ms[2], pid);
    expect(r).toEqual({ signatures: 3, queued: true });
    const st = await participation.proposalStatus(ctx, pid);
    expect(st).toMatchObject({ status: "under_consideration", signatures: 3 });
    expect(JSON.stringify(st)).not.toContain(ms[0]);
    const ag = await ctx.db.query<{ respond_by: Date }>("SELECT respond_by FROM agenda");
    expect(ag).toHaveLength(1);
  });
  it("resigned and unknown people cannot sign", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const pid = await participation.createProposal(ctx, m.memberId, "t", "b", 5);
    await members.resign(ctx, m.memberId);
    await expect(participation.signProposal(ctx, m.memberId, pid)).rejects.toMatchObject({ code: "not_member" });
  });
});

describe("USSD journey (Musa)", () => {
  it("join, dues, card, end to end", async () => {
    const { ctx, sms } = await setup();
    const phone = "+2348055550000";
    const nin = freshNin();
    expect(await handleUssd(ctx, phone, "")).toMatch(/^CON .*Join/s);
    expect(await handleUssd(ctx, phone, "1")).toMatch(/^CON .*NIN/);
    expect(await handleUssd(ctx, phone, `1*${nin}`)).toMatch(/^CON Is this you\? MUS/);
    expect(await handleUssd(ctx, phone, `1*${nin}*1`)).toMatch(/INEC/);
    expect(await handleUssd(ctx, phone, `1*${nin}*1*2`)).toMatch(/PIN/);
    expect(await handleUssd(ctx, phone, `1*${nin}*1*2*4321`)).toMatch(/Repeat/);
    expect(await handleUssd(ctx, phone, `1*${nin}*1*2*4321*9999`)).toMatch(/did not match/);
    expect(await handleUssd(ctx, phone, `1*${nin}*1*2*4321*4321`)).toMatch(/^END You have joined. Card number OP-/);
    expect(sms.outbox.at(-1)!.text).toMatch(/card number is OP-/);
    const row = (await ctx.db.query<{ visibility: string; state: string }>("SELECT visibility,state FROM members"))[0];
    expect(row).toEqual({ visibility: "anonymous", state: "provisional" });

    expect(await handleUssd(ctx, phone, "2*0000")).toMatch(/Wrong PIN/);
    expect(await handleUssd(ctx, phone, "2*4321")).toMatch(/Amount/);
    expect(await handleUssd(ctx, phone, "2*4321*500")).toMatch(/^END Dues of N500 received/);
    expect((await finance.reconcile(ctx)).byKind.dues.totalMinor).toBe(50_000);
    expect(await handleUssd(ctx, phone, "3*4321")).toMatch(/Status: provisional/);
  });
  it("duplicate NIN is refused over USSD with a readable message", async () => {
    const { ctx } = await setup();
    const nin = freshNin();
    await handleUssd(ctx, "+2348055550001", `1*${nin}`);
    await handleUssd(ctx, "+2348055550001", `1*${nin}*1*1*1111*1111`);
    expect(await handleUssd(ctx, "+2348055550002", `1*${nin}`)).toMatch(/^END .*already/);
  });
});

describe("HTTP: signed admin requests", () => {
  it("rejects missing, bad, stale and replayed signatures; logs access", async () => {
    const { ctx, log } = await setup();
    const app = buildServer(ctx);
    const sec = await makeAdmin(ctx, "secretary");
    const body = JSON.stringify({ name: "H", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY).toISOString() });
    const post = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/admin/contests", headers: { "content-type": "application/json", ...headers }, payload: body });

    expect((await post({})).statusCode).toBe(401);
    const good = sec.headers("POST", "/admin/contests", body);
    expect((await post({ ...good, "x-signature": "00".repeat(64) })).statusCode).toBe(401);
    const ok = await post(good);
    expect(ok.statusCode).toBe(200);
    expect((await post(good)).statusCode).toBe(401); // replay
    expect((await ctx.db.query("SELECT 1 FROM access_log")).length).toBe(1);
    expect(log.events.some((e) => e.type === "admin.access")).toBe(true);
    // wrong role
    const tre = await makeAdmin(ctx, "treasurer");
    expect((await post(tre.headers("POST", "/admin/contests", body))).statusCode).toBe(403);
  });
  it("USSD webhook accepts form-encoded gateway posts", async () => {
    const { ctx } = await setup();
    const app = buildServer(ctx);
    const r = await app.inject({ method: "POST", url: "/ussd", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "sessionId=1&phoneNumber=%2B2348000000099&text=" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/^CON /);
  });
});
