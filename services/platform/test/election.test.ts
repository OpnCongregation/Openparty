import { describe, expect, it } from "vitest";
import { approve, propose } from "../src/admin.js";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import * as election from "../src/election.js";
import { voteStep } from "../src/ussd.js";
import { handleUssd } from "../src/ussd.js";
import { resign, erase } from "../src/members.js";
import { joinAndActivate, makeAdmin, setup } from "./helpers.js";

const PIN = "1234";
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as any).code as string);

/** A contest with a notice out, one race, and `n` active members, ready for candidates. Nothing is frozen or open yet. */
async function world(n = 5, feeMinor = 0) {
  const s = await setup();
  const { ctx } = s;
  const agent = await makeAdmin(ctx, "ward_agent", "W1");
  const otherAgent = await makeAdmin(ctx, "ward_agent", "W2");
  const sec = await makeAdmin(ctx, "secretary");
  const ec = await makeAdmin(ctx, "electoral_committee");
  const aud = await makeAdmin(ctx, "auditor");
  const treasurer = await makeAdmin(ctx, "treasurer");
  const tribunal = await makeAdmin(ctx, "tribunal");
  const ms = [];
  for (let i = 0; i < n; i++) ms.push(await joinAndActivate(ctx, agent));
  const cid = await contests.createContest(ctx, { name: "Primary", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY) });
  await contests.generateNotice(ctx, cid);
  const { raceId } = await election.createRace(ctx, sec, { contestId: cid, office: "National Chairman", formFeeMinor: feeMinor });
  const apply = (m: { phone: string }, race = raceId) => election.registerCandidate(ctx, { phone: m.phone, pin: PIN, raceId: race, consentPublic: true });
  /** Freeze the register, record the INEC receipts, wait for the vote date and open. */
  const open = async () => {
    await contests.recordNoticeReceipt(ctx, cid, "INEC-N-001");
    const f = await contests.freezeRegister(ctx, cid);
    await contests.recordRegisterReceipt(ctx, f.registerId, "INEC-R-001");
    s.advance(40);
    await contests.openContest(ctx, cid);
  };
  const vote = (m: { phone: string }, choices: Record<string, string | null>) => election.webVote(ctx, { phone: m.phone, pin: PIN, contestId: cid, choices });
  const close = async () => { await contests.closeContest(ctx, cid); await ctx.events.flush(); };
  return { ...s, agent, otherAgent, sec, ec, aud, treasurer, tribunal, ms, cid, raceId, apply, open, vote, close };
}

describe("races", () => {
  it("only the secretary or electoral committee set the ballot, before voting opens", async () => {
    const { ctx, log, sec, ec, treasurer, aud, cid, open } = await world(2);
    await expect(election.createRace(ctx, treasurer, { contestId: cid, office: "Treasurer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(election.createRace(ctx, aud, { contestId: cid, office: "Treasurer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(election.createRace(ctx, ec, { contestId: cid, office: "Deputy National Chairman (North)", scope: "North, East" })).resolves.toHaveProperty("raceId");
    await expect(election.createRace(ctx, sec, { contestId: cid, office: "National Chairman" })).rejects.toMatchObject({ code: "race_exists" });
    await expect(election.createRace(ctx, sec, { contestId: cid, office: "<script>" })).rejects.toMatchObject({ code: "bad_office" });
    await expect(election.createRace(ctx, sec, { contestId: cid, office: "X", formFeeMinor: -1 })).rejects.toMatchObject({ code: "bad_fee" });
    await open();
    await expect(election.createRace(ctx, sec, { contestId: cid, office: "Late Office" })).rejects.toMatchObject({ code: "candidacy_closed" });
    await ctx.events.flush();
    expect(log.events.filter((e: any) => e.type === "race.created")).toHaveLength(2);
  });
});

describe("candidates: anyone who registers to compete is one", () => {
  it("is public: name on the log, visibility forced to visible, consent required, erasure blocked", async () => {
    const { ctx, log, ms, apply, raceId } = await world(3);
    await expect(election.registerCandidate(ctx, { phone: ms[0].phone, pin: PIN, raceId, consentPublic: false })).rejects.toMatchObject({ code: "consent_required" });
    await expect(election.registerCandidate(ctx, { phone: ms[0].phone, pin: "9999", raceId, consentPublic: true })).rejects.toMatchObject({ code: "pin_wrong" });
    const r = await apply(ms[0]);
    expect(r).toMatchObject({ state: "listed", feeMinor: 0 });
    expect((await ctx.db.query<any>("SELECT visibility FROM members WHERE id=$1", [ms[0].memberId]))[0].visibility).toBe("visible");
    await ctx.events.flush();
    const ev = log.events.find((e: any) => e.type === "candidate.registered")!.data;
    expect(ev.candidate).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const dump = JSON.stringify(log.events);
    for (const secret of [ms[0].nin, ms[0].phone]) expect(dump).not.toContain(secret); // the name is public; the ID and phone never are
    await expect(apply(ms[0])).rejects.toMatchObject({ code: "already_candidate" });
    await expect(erase(ctx, ms[0].memberId)).rejects.toMatchObject({ code: "legal_hold" });
    expect((await election.listElection(ctx, (await ctx.db.query<any>("SELECT contest_id FROM races WHERE id=$1", [raceId]))[0].contest_id)).races[0].candidates).toHaveLength(1);
  });

  it("a provisional member cannot stand; candidacy closes when voting opens; a candidate may withdraw and return before then", async () => {
    const { ctx, ms, apply, open, raceId, cid } = await world(3);
    const { prepareJoin, confirmJoin } = await import("../src/members.js");
    const { freshNin } = await import("./helpers.js");
    await prepareJoin(ctx, "+2348077700001", freshNin());
    await confirmJoin(ctx, "+2348077700001", "visible", PIN);
    await expect(election.registerCandidate(ctx, { phone: "+2348077700001", pin: PIN, raceId, consentPublic: true })).rejects.toMatchObject({ code: "not_active" });

    const r = await apply(ms[0]);
    await election.withdrawCandidate(ctx, { phone: ms[0].phone, pin: PIN, candidacyId: r.candidacyId });
    expect((await election.listElection(ctx, cid)).races[0].candidates).toHaveLength(0);
    await expect(apply(ms[0])).resolves.toMatchObject({ candidacyId: r.candidacyId, state: "listed" }); // same candidacy, back on the list
    await apply(ms[1]);
    await open();
    await expect(apply(ms[2])).rejects.toMatchObject({ code: "candidacy_closed" });
    await expect(election.withdrawCandidate(ctx, { phone: ms[0].phone, pin: PIN, candidacyId: r.candidacyId })).rejects.toMatchObject({ code: "candidacy_closed" });
  });
});

describe("candidate forms can be bought", () => {
  it("a race with a fee lists the candidate only once the fee is paid, once, and the ledger and log agree", async () => {
    const { ctx, log, ms, apply, cid } = await world(3, 500_000);
    const r = await apply(ms[0]);
    expect(r).toMatchObject({ state: "pending_payment", feeMinor: 500_000 });
    expect((await election.listElection(ctx, cid)).races[0].candidates).toHaveLength(0); // not on the ballot yet
    expect((await election.listElection(ctx, cid, { admin: true })).races[0].candidates).toHaveLength(1); // admins see who is unpaid

    await expect(election.payForm(ctx, { phone: ms[1].phone, pin: PIN, candidacyId: r.candidacyId })).rejects.toMatchObject({ code: "not_found" }); // someone else's form
    const paid = await election.payForm(ctx, { phone: ms[0].phone, pin: PIN, candidacyId: r.candidacyId });
    expect(paid.duplicate).toBe(false);
    expect((await election.listElection(ctx, cid)).races[0].candidates).toHaveLength(1);
    await expect(election.payForm(ctx, { phone: ms[0].phone, pin: PIN, candidacyId: r.candidacyId })).rejects.toMatchObject({ code: "already_paid" });

    await ctx.events.flush();
    expect(await ctx.db.query("SELECT 1 FROM finance_ledger WHERE kind='form' AND amount_minor=500000")).toHaveLength(1);
    expect(log.events.filter((e: any) => e.type === "finance.form")).toHaveLength(1);
    expect(log.events.filter((e: any) => e.type === "candidate.listed")).toHaveLength(1);
    const { checkConsistency } = await import("../src/consistency.js").catch(() => ({ checkConsistency: undefined as any }));
    if (checkConsistency) expect((await checkConsistency(ctx.db, log as any)).problems).toEqual([]);
  });

  it("a crash between the charge and the listing is finished by the retry, with one charge and one listing", async () => {
    const { ctx, log, ms, apply, cid } = await world(2, 100_000);
    const r = await apply(ms[0]);
    const real = ctx.payments.charge.bind(ctx.payments);
    let charges = 0;
    ctx.payments.charge = async (...a: Parameters<typeof real>) => { charges++; return real(...a); };
    ctx.crashAt = undefined;
    // make the ledger step fail once, after the provider has charged
    const original = ctx.commit.bind(ctx);
    let failOnce = true;
    ctx.commit = async (fn) => { if (failOnce) { failOnce = false; throw new Error("database went away"); } return original(fn); };
    await expect(election.payForm(ctx, { phone: ms[0].phone, pin: PIN, candidacyId: r.candidacyId })).rejects.toThrow(/database went away/);
    ctx.commit = original;
    expect((await election.listElection(ctx, cid)).races[0].candidates).toHaveLength(0);
    const { retryUnrecorded } = await import("../src/finance.js");
    expect(await retryUnrecorded(ctx)).toMatchObject({ recorded: 1 });
    expect(charges).toBe(1);
    await ctx.events.flush();
    expect((await election.listElection(ctx, cid)).races[0].candidates).toHaveLength(1);
    expect(log.events.filter((e: any) => e.type === "finance.form")).toHaveLength(1);
    expect(await ctx.db.query("SELECT 1 FROM finance_ledger WHERE kind='form'")).toHaveLength(1);
  });
});

describe("vetting stamps: information, never a gate", () => {
  it("every admin can stamp, a flagged candidate stays on the ballot, one stamp per admin", async () => {
    const { ctx, log, ms, apply, cid, sec, ec, aud, tribunal, treasurer, agent } = await world(3);
    const k = await apply(ms[0]);
    await election.stampCandidate(ctx, sec, k.candidacyId, "vetted", "documents seen");
    await election.stampCandidate(ctx, aud, k.candidacyId, "flagged", "asset declaration missing");
    await election.stampCandidate(ctx, tribunal, k.candidacyId, "vetted");
    await election.stampCandidate(ctx, treasurer, k.candidacyId, "vetted");
    await election.stampCandidate(ctx, agent, k.candidacyId, "vetted");
    await election.stampCandidate(ctx, ec, k.candidacyId, "flagged");
    await election.stampCandidate(ctx, ec, k.candidacyId, "vetted"); // the same admin changes their stamp
    const c = (await election.listElection(ctx, cid)).races[0].candidates[0];
    expect(c).toMatchObject({ vetted: 5, flagged: 1, status: "mixed" });
    expect((await election.listElection(ctx, cid, { admin: true })).races[0].candidates[0].stamps).toHaveLength(6);
    await expect(election.stampCandidate(ctx, sec, k.candidacyId, "rejected")).rejects.toMatchObject({ code: "bad_verdict" });
    await expect(election.stampCandidate(ctx, sec, "nope", "vetted")).rejects.toMatchObject({ code: "not_found" });
    await ctx.events.flush();
    expect(JSON.stringify(log.events)).not.toContain("asset declaration"); // notes are for the record, not the log
  });

  it("a flagged candidate can still be voted for and win", async () => {
    const { ctx, ms, apply, aud, open, vote, close, cid, raceId } = await world(3);
    const k = await apply(ms[0]);
    await election.stampCandidate(ctx, aud, k.candidacyId, "flagged", "concern");
    await open();
    await vote(ms[1], { [raceId]: k.candidacyId }); await vote(ms[2], { [raceId]: k.candidacyId });
    await close();
    expect((await election.results(ctx, cid)).races[0]).toMatchObject({ winnerId: k.candidacyId });
  });
});

describe("voting: one member, one vote, last ballot counts", () => {
  async function ready() {
    const w = await world(6);
    const a = await w.apply(w.ms[0]); const b = await w.apply(w.ms[1]);
    await w.open();
    return { ...w, a: a.candidacyId, b: b.candidacyId };
  }

  it("before opening and after closing nobody can vote; results are hidden until the close", async () => {
    const w = await world(4);
    const k = await w.apply(w.ms[0]);
    await expect(w.vote(w.ms[1], { [w.raceId]: k.candidacyId })).rejects.toMatchObject({ code: "not_open" });
    await w.open();
    await w.vote(w.ms[1], { [w.raceId]: k.candidacyId });
    await expect(election.results(w.ctx, w.cid)).rejects.toMatchObject({ code: "results_not_ready" });
    await w.close();
    await expect(w.vote(w.ms[2], { [w.raceId]: k.candidacyId })).rejects.toMatchObject({ code: "not_open" });
    expect((await election.results(w.ctx, w.cid)).races[0].candidates[0].votes).toBe(1);
  });

  it("re-voting replaces the earlier ballot; abstaining is a choice; the receipt stays the same", async () => {
    const { ctx, ms, vote, close, cid, raceId, a, b } = await ready();
    const r1 = await vote(ms[2], { [raceId]: a });
    const r2 = await vote(ms[2], { [raceId]: b });
    expect(r2.receipts[0]).toMatchObject({ revision: 2, receipt: r1.receipts[0].receipt });
    await vote(ms[3], { [raceId]: null });
    await vote(ms[4], { [raceId]: a });
    await close();
    const res = (await election.results(ctx, cid)).races[0];
    expect(res.candidates.find((c) => c.candidacyId === a)!.votes).toBe(1);
    expect(res.candidates.find((c) => c.candidacyId === b)!.votes).toBe(1);
    expect(res).toMatchObject({ ballots: 3, abstained: 1, eligible: 6, tie: true, winnerId: null });
  });

  it("only members on the frozen register who are still active may vote", async () => {
    const w = await world(4);
    const k = await w.apply(w.ms[0]);
    await contests.recordNoticeReceipt(w.ctx, w.cid, "INEC-N-001");
    const f = await contests.freezeRegister(w.ctx, w.cid);
    await contests.recordRegisterReceipt(w.ctx, f.registerId, "INEC-R-001");
    const late = await joinAndActivate(w.ctx, w.agent); // joined after the freeze
    await resign(w.ctx, w.ms[3].memberId);             // resigned after the freeze
    w.advance(40); await contests.openContest(w.ctx, w.cid);
    await expect(w.vote(late, { [w.raceId]: k.candidacyId })).rejects.toMatchObject({ code: "not_eligible" });
    await expect(election.webVote(w.ctx, { phone: w.ms[3].phone, pin: PIN, contestId: w.cid, choices: { [w.raceId]: k.candidacyId } })).rejects.toMatchObject({ code: "no_member" });
    await expect(w.vote(w.ms[1], { [w.raceId]: k.candidacyId })).resolves.toHaveProperty("receipts");
  });

  it("refuses a candidate from another race, a withdrawn or unpaid candidate, and malformed choices", async () => {
    const w = await ready();
    const other = await election.createRace(w.ctx, w.sec, { contestId: w.cid, office: "Late" }).catch((e) => e);
    expect(other.code).toBe("candidacy_closed");
    await expect(w.vote(w.ms[2], { [w.raceId]: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "bad_choice" });
    await expect(w.vote(w.ms[2], { "not-a-uuid": null })).rejects.toMatchObject({ code: "bad_choice" });
    await expect(w.vote(w.ms[2], {})).rejects.toMatchObject({ code: "nothing_to_do" });
    await expect(w.vote(w.ms[2], { "00000000-0000-4000-8000-000000000000": null })).rejects.toMatchObject({ code: "bad_choice" });
  });

  it("a ward agent can help a member of their own ward; the agent is recorded; other wards and other roles are refused", async () => {
    const { ctx, agent, otherAgent, sec, ms, close, cid, raceId, a } = await ready();
    const asAgent = (ag: any, m: any) => election.agentVote(ctx, ag, { phone: m.phone, pin: PIN, contestId: cid, choices: { [raceId]: a } });
    await expect(asAgent(otherAgent, ms[2])).rejects.toMatchObject({ code: "wrong_ward" });
    await expect(asAgent(sec, ms[2])).rejects.toMatchObject({ code: "forbidden" });
    await expect(election.agentVote(ctx, agent, { phone: ms[2].phone, pin: "0000", contestId: cid, choices: { [raceId]: a } })).rejects.toMatchObject({ code: "pin_wrong" });
    await asAgent(agent, ms[2]);
    const row = (await ctx.db.query<any>("SELECT channel, agent_id FROM ballots WHERE member_id=$1", [ms[2].memberId]))[0];
    expect(row).toEqual({ channel: "agent", agent_id: agent.id });
    await close();
  });

  it("parallel casts by one member leave one ballot; voting racing the close is either counted or refused, never lost", async () => {
    const { ctx, ms, vote, cid, raceId, a, b } = await ready();
    await Promise.all([vote(ms[2], { [raceId]: a }), vote(ms[2], { [raceId]: b }), vote(ms[2], { [raceId]: a })]);
    const rows = await ctx.db.query<any>("SELECT revision FROM ballots WHERE member_id=$1", [ms[2].memberId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(3);
    const settled = await Promise.allSettled([vote(ms[3], { [raceId]: a }), contests.closeContest(ctx, cid)]);
    expect(settled[1].status).toBe("fulfilled");
    const counted = (await ctx.db.query("SELECT 1 FROM ballots WHERE member_id=$1", [ms[3].memberId])).length;
    expect(counted).toBe(settled[0].status === "fulfilled" ? 1 : 0);
    const res = (await election.results(ctx, cid)).races[0];
    expect(res.ballots).toBe(1 + counted); // the published total equals what is in the box
  });
});

describe("the public log learns counts, never voters", () => {
  it("ballot events carry an anonymous receipt and channel only; the close publishes turnout and per-candidate results atomically", async () => {
    const { ctx, log, ms, apply, open, vote, sec, ec, aud, cid, raceId } = await world(5);
    const a = await apply(ms[0]); await apply(ms[1]);
    await open();
    await vote(ms[2], { [raceId]: a.candidacyId }); await vote(ms[3], { [raceId]: a.candidacyId });
    // close through the approvals path, like production
    const id = await propose(ctx, ec, "contest.close", { contestId: cid });
    await approve(ctx, sec, id); await approve(ctx, aud, id);
    await ctx.events.flush();
    const ballots = log.events.filter((e: any) => e.type === "ballot.cast");
    expect(ballots).toHaveLength(2);
    for (const e of ballots) expect(Object.keys(e.data).sort()).toEqual(["ballot_ref", "channel", "contest_id", "race_id", "revision"]);
    expect(log.events.find((e: any) => e.type === "race.turnout")!.data).toMatchObject({ ballots: 2, abstained: 0, eligible: 5 });
    const results = log.events.filter((e: any) => e.type === "race.result");
    expect(results).toHaveLength(2);
    expect(results.find((e: any) => e.data.candidacy_id === a.candidacyId)!.data.votes).toBe(2);
    const dump = JSON.stringify(log.events);
    for (const m of ms) for (const secret of [m.nin, m.phone]) expect(dump).not.toContain(secret);
  });
});

describe("more than one contest open at once", () => {
  it("sends each voter to the contest they can vote in", async () => {
    const w = await world(3);
    const k = await w.apply(w.ms[0]);
    await w.open();                                                   // contest A is open; ms[0..2] are on its register
    const late = await joinAndActivate(w.ctx, w.agent);                // joined after A's freeze
    const cid2 = await contests.createContest(w.ctx, { name: "Second", primaryType: "direct", mode: "virtual", voteDate: new Date(w.ctx.clock().getTime() + 25 * DAY) });
    await contests.generateNotice(w.ctx, cid2);
    const sec = w.sec;
    const r2 = (await election.createRace(w.ctx, sec, { contestId: cid2, office: "Treasurer" })).raceId;
    await election.registerCandidate(w.ctx, { phone: w.ms[1].phone, pin: PIN, raceId: r2, consentPublic: true });
    await contests.recordNoticeReceipt(w.ctx, cid2, "INEC-N-002");
    const f2 = await contests.freezeRegister(w.ctx, cid2);          // includes `late`
    await contests.recordRegisterReceipt(w.ctx, f2.registerId, "INEC-R-002");
    w.advance(25); await contests.openContest(w.ctx, cid2);
    // an old member is on both registers, so the earliest vote date (contest A) comes first; the late joiner is only on contest B
    expect((await election.webBallot(w.ctx, { phone: w.ms[2].phone, pin: PIN })).ballot.contestId).toBe(w.cid);
    const mine = await election.webBallot(w.ctx, { phone: late.phone, pin: PIN });
    expect(mine.ballot).toMatchObject({ contestId: cid2, eligible: true });
    expect(k.candidacyId).toBeTruthy();
  });
});

describe("voting by USSD", () => {
  it("menu option 5: pick per race, confirm, get a receipt; dial again to change it", async () => {
    const { ctx, sms, ms, apply, open, sec, cid, raceId } = await world(4);
    const r2 = (await election.createRace(ctx, sec, { contestId: cid, office: "Secretary", scope: "National" })).raceId;
    await apply(ms[0]); await apply(ms[1]); await apply(ms[0], r2);
    const phone = ms[2].phone;
    expect(await handleUssd(ctx, phone, "")).toContain("5 Vote");
    await open();
    expect(await handleUssd(ctx, phone, "5")).toMatch(/PIN/);
    const s1 = await handleUssd(ctx, phone, `5*${PIN}`);
    expect(s1).toMatch(/^CON National Chairman \(1\/2\)\n1 .+\n2 .+\n0 Abstain$/);
    const s2 = await handleUssd(ctx, phone, `5*${PIN}*2`);
    expect(s2).toMatch(/^CON Secretary \(2\/2\)\n1 .+\n0 Abstain$/);
    const s3 = await handleUssd(ctx, phone, `5*${PIN}*2*0`);
    expect(s3).toMatch(/^CON Confirm\?\n.*\n.*\n1 Yes 2 No$/);
    expect(s3.length).toBeLessThanOrEqual(182);
    expect(await handleUssd(ctx, phone, `5*${PIN}*2*0*2`)).toMatch(/^END Cancelled/);
    expect((await ctx.db.query("SELECT 1 FROM ballots")).length).toBe(0);
    const done = await handleUssd(ctx, phone, `5*${PIN}*2*0*1`);
    expect(done).toMatch(/^END Vote counted\. Receipt [0-9A-F]{8}\./);
    expect(sms.outbox.at(-1)!.text).toContain("Your vote was counted");
    const mine = await ctx.db.query<any>("SELECT race_id, candidacy_id, channel FROM ballots WHERE member_id=$1 ORDER BY race_id", [ms[2].memberId]);
    expect(mine).toHaveLength(2);
    expect(mine.every((b: any) => b.channel === "ussd")).toBe(true);
    expect(mine.find((b: any) => b.race_id === r2).candidacy_id).toBeNull(); // abstained in the second race
    expect(await handleUssd(ctx, phone, `5*${PIN}*1*1*1`)).toMatch(/^END Vote counted/); // changed
    expect((await ctx.db.query<any>("SELECT revision FROM ballots WHERE race_id=$1 AND member_id=$2", [raceId, ms[2].memberId]))[0].revision).toBe(2);
  });

  it("refuses a wrong PIN, a non-voter, a bad answer, and says so when nothing is open", async () => {
    const { ctx, ms, apply, open } = await world(3);
    expect(await handleUssd(ctx, ms[0].phone, `5*${PIN}`)).toMatch(/^END No contest is open/);
    await apply(ms[0]);
    await open();
    expect(await handleUssd(ctx, ms[1].phone, "5*9999")).toMatch(/^END Wrong PIN/);
    expect(await handleUssd(ctx, ms[1].phone, `5*${PIN}*7`)).toMatch(/^END Invalid choice/);
    expect(await handleUssd(ctx, ms[1].phone, `5*${PIN}*1*3`)).toMatch(/^END Invalid choice/);
  });

  it("voteStep pages through more than eight candidates", () => {
    const cands = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, name: `Candidate ${i + 1}` }));
    const races = [{ id: "r1", office: "Chair", candidates: cands, current: null }];
    expect((voteStep(races, []) as any).prompt).toContain("9 More");
    expect((voteStep(races, ["9"]) as any).prompt).toMatch(/^Chair \(1\/1\)\n1 Candidate 9\n2 Candidate 10\n3 Candidate 11\n0 Abstain$/);
    const done = voteStep(races, ["9", "3", "1"]) as any;
    expect(done).toEqual({ confirmed: true, choices: { r1: "c10" } });
    expect(() => voteStep(races, ["4"])).not.toThrow();
    expect(() => voteStep(races, ["9", "9"])).toThrow(); // no third page
  });
});
