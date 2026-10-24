import { describe, expect, it } from "vitest";
import { approve, propose } from "../src/admin.js";
import * as contests from "../src/contests.js";
import { DAY, type Ctx } from "../src/context.js";
import * as election from "../src/election.js";
import * as sb from "../src/secret-ballot.js";
import type { EgClient } from "../src/eg-client.js";
import { handleUssd } from "../src/ussd.js";
import { joinAndActivate, makeAdmin } from "./helpers.js";
import { PIN, world } from "./sb-world.js";
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as any).code as string);


describe("guardians: five members of the electoral committee, appointed by others", () => {
  it("only the secretary proposes; only the auditor and tribunal approve; the committee cannot pick its own guardians", async () => {
    const w = await world();
    const payload = { contestId: w.cid, adminIds: w.ecs.map((e) => e.id) };
    await expect(propose(w.ctx, w.ecs[0], "guardians.appoint", payload)).rejects.toMatchObject({ code: "forbidden" });
    const id = await propose(w.ctx, w.sec, "guardians.appoint", payload);
    await expect(approve(w.ctx, w.ecs[1], id)).rejects.toMatchObject({ code: "forbidden" });
    await approve(w.ctx, w.aud, id);
    expect((await w.ctx.db.query("SELECT 1 FROM guardians")).length).toBe(0); // one approval is not enough
    await approve(w.ctx, w.tri, id);
    expect((await w.ctx.db.query("SELECT 1 FROM guardians WHERE contest_id=$1", [w.cid])).length).toBe(5);
    await w.ctx.events.flush();
    expect(w.log.events.find((e: any) => e.type === "guardians.appointed")!.data).toMatchObject({ n: 5, quorum: 3 });
  });

  it("refuses the wrong people: not five, repeats, non-committee members, the inactive, and another jurisdiction", async () => {
    const w = await world();
    const ids = w.ecs.map((e) => e.id);
    const go = (adminIds: string[]) => code(sb.appointGuardians(w.ctx, { contestId: w.cid, adminIds }));
    expect(await go(ids.slice(0, 4))).toBe("bad_guardians");
    expect(await go([...ids.slice(0, 4), ids[0]])).toBe("bad_guardians");
    expect(await go([...ids.slice(0, 4), w.aud.id])).toBe("bad_guardians"); // an auditor is not on the electoral committee
    expect(await go([...ids.slice(0, 4), "no-such-admin"])).toBe("bad_guardians");
    await w.ctx.db.query("UPDATE admins SET active=FALSE WHERE id=$1", [ids[4]]);
    expect(await go(ids)).toBe("bad_guardians");
    await w.ctx.db.query("UPDATE admins SET active=TRUE WHERE id=$1", [ids[4]]);
    // a contest for one state takes its guardians from that state's electoral committee
    await w.ctx.db.query("UPDATE contests SET jurisdiction='Kano' WHERE id=$1", [w.cid]);
    await w.ctx.db.query("UPDATE admins SET jurisdiction='Kano' WHERE id = ANY($1)", [ids.slice(0, 4)]);
    await w.ctx.db.query("UPDATE admins SET jurisdiction='Lagos' WHERE id=$1", [ids[4]]);
    expect(await go(ids)).toBe("bad_guardians");
    await w.ctx.db.query("UPDATE admins SET jurisdiction='Kano' WHERE id=$1", [ids[4]]);
    expect(await go(ids)).toBe("ok");
    expect(await go(ids)).toBe("already_appointed");
  });
});

describe("the key ceremony", () => {
  it("runs in order, only for appointed guardians, and combines the five public keys into the election key", async () => {
    const w = await world();
    await w.appoint();
    await expect(sb.ceremonyView(w.ctx, w.treasurer, w.cid)).rejects.toMatchObject({ code: "forbidden" });
    const outsider = await makeAdmin(w.ctx, "electoral_committee");
    await expect(sb.ceremonyView(w.ctx, outsider, w.cid)).rejects.toMatchObject({ code: "not_a_guardian" });
    expect((await sb.ceremonyView(w.ctx, w.ecs[0], w.cid)).step).toBe("post_key");

    const k0 = await w.eg.guardian.init(w.ecs[0].id, 1, 5, 3);
    // wrong person, wrong position: refused
    expect(await code(sb.postKey(w.ctx, w.ecs[1], w.cid, k0.public))).toBe("bad_key");
    expect(await code(sb.postKey(w.ctx, w.ecs[0], w.cid, JSON.stringify({ owner_id: w.ecs[0].id, sequence_order: 3 })))).toBe("bad_key");
    expect(await code(sb.postKey(w.ctx, w.ecs[0], w.cid, k0.public))).toBe("ok");
    expect(await code(sb.postKey(w.ctx, w.ecs[0], w.cid, k0.public))).toBe("already_posted");
    // backups and verification cannot jump the queue
    expect(await code(sb.postBackups(w.ctx, w.ecs[0], w.cid, []))).toBe("wait");
    expect(await code(sb.postVerification(w.ctx, w.ecs[0], w.cid, { all_verified: true, verifications: [] }))).toBe("wait");

    await w.ceremony().catch(() => undefined); // the others continue; ecs[0] already posted, so the helper stops there
    const fresh = await world();
    await fresh.appoint();
    await fresh.ceremony();
    const keys = await sb.keysOf(fresh.ctx.db, fresh.cid);
    expect(keys).toMatchObject({ n: 5, quorum: 3 });
    expect(keys!.joint_public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(keys!.sealed_at).toBeNull();
    await fresh.ctx.events.flush();
    for (const t of ["guardian.key_posted", "guardian.verified", "ceremony.completed"]) expect(fresh.log.events.some((e: any) => e.type === t)).toBe(true);
    expect(fresh.log.events.filter((e: any) => e.type === "guardian.key_posted")).toHaveLength(5);
  });

  it("a bad backup stops the ceremony and no election key is made", async () => {
    const w = await world();
    await w.appoint();
    const priv: Record<string, string> = {};
    for (const [i, g] of w.ecs.entries()) { const k = await w.eg.guardian.init(g.id, i + 1, 5, 3); priv[g.id] = k.private; await sb.postKey(w.ctx, g, w.cid, k.public); }
    for (const g of w.ecs) { const v = await sb.ceremonyView(w.ctx, g, w.cid); const o = await w.eg.guardian.backups(priv[g.id], v.publicKeys); await sb.postBackups(w.ctx, g, w.cid, o.backups); }
    // a backup that is not from this guardian, or not for a different guardian, is refused at posting time
    expect(await code(sb.postBackups(w.ctx, w.ecs[0], w.cid, ["{}"]))).toBe("already_posted");
    const v = await sb.ceremonyView(w.ctx, w.ecs[1], w.cid);
    const out = await w.eg.guardian.receive(priv[w.ecs[1].id], v.backupsForMe);
    expect(await code(sb.postVerification(w.ctx, w.ecs[1], w.cid, { all_verified: false, verifications: out.verifications.map((x) => ({ ...x, verified: false })) }))).toBe("verification_failed");
    expect(await sb.keysOf(w.ctx.db, w.cid)).toBeNull();
  });
});

describe("sealing the election", () => {
  it("needs the keys first, an approved action by others, and fixes the ballot for good", async () => {
    const w = await world();
    await expect(sb.sealElection(w.ctx, { contestId: w.cid })).rejects.toMatchObject({ code: "no_keys" });
    await w.appoint(); await w.ceremony();
    await expect(sb.sealElection(w.ctx, { contestId: w.cid })).rejects.toMatchObject({ code: "no_register" }); // the group of voters is built from the frozen register
    await w.freeze();
    const id = await propose(w.ctx, w.sec, "election.seal", { contestId: w.cid });
    await approve(w.ctx, w.aud, id);
    expect((await sb.keysOf(w.ctx.db, w.cid))!.sealed_at).toBeNull();
    await approve(w.ctx, w.tri, id);
    const keys = (await sb.keysOf(w.ctx.db, w.cid))!;
    expect(keys.sealed_at).not.toBeNull();
    const spec = JSON.parse(keys.manifest!);
    expect(spec.contests.map((c: any) => c.id).sort()).toEqual([w.raceA, w.raceB].sort());
    expect(spec.contests.find((c: any) => c.id === w.raceA).candidates).toHaveLength(2);

    // after the seal nobody can change the ballot
    const late = w.ms[5];
    expect(await code(election.registerCandidate(w.ctx, { phone: late.phone, pin: PIN, raceId: w.raceA, consentPublic: true }))).toBe("candidacy_closed");
    expect(await code(election.createRace(w.ctx, w.sec, { contestId: w.cid, office: "Treasurer" }))).toBe("candidacy_closed");
    expect(await code(election.withdrawCandidate(w.ctx, { phone: w.ms[0].phone, pin: PIN, candidacyId: w.a0 }))).toBe("candidacy_closed");
    expect(await code(sb.sealElection(w.ctx, { contestId: w.cid }))).toBe("already_sealed");
  });

  it("refuses an empty ballot, and voting cannot open on an unsealed election while the service is configured", async () => {
    const w = await world();
    await w.appoint(); await w.ceremony(); await w.freeze();
    await w.ctx.db.query("UPDATE candidacies SET state='withdrawn'");
    expect(await code(sb.sealElection(w.ctx, { contestId: w.cid }))).toBe("empty_ballot");
    await w.ctx.db.query("UPDATE candidacies SET state='listed'");
    w.advance(40);
    expect(await code(contests.openContest(w.ctx, w.cid))).toBe("not_sealed");
    process.env.ALLOW_PLAIN_BALLOT = "1";
    try { expect(await code(contests.openContest(w.ctx, w.cid))).toBe("ok"); } finally { delete process.env.ALLOW_PLAIN_BALLOT; }
  });
});

describe("casting a secret ballot", () => {
  it("stores no member id: ciphertext, a nullifier and a day; who voted is kept apart, with no link", async () => {
    const w = await world();
    await w.ready();
    const m = w.ms[3];
    const r = await w.vote(m, { [w.raceA]: w.a0, [w.raceB]: null });
    expect(r.receipts[0].receipt).toMatch(/^[0-9a-f]{64}$/);
    const cols = (await w.ctx.db.query<any>("SELECT * FROM enc_ballots"))[0];
    expect(Object.keys(cols).sort()).toEqual(["ballot", "ballot_code", "cast_day", "channel", "contest_id", "id", "nullifier", "proof", "superseded", "unit"]);
    const dump = JSON.stringify(await w.ctx.db.query("SELECT * FROM enc_ballots"));
    for (const secret of [m.memberId, m.phone, m.nin]) expect(dump).not.toContain(secret);
    expect(cols.nullifier).not.toBe(m.memberId);
    expect(new Date(cols.cast_day).getUTCHours()).toBe(0); // a day, not a time
    const turnout = await w.ctx.db.query<any>("SELECT * FROM voted");
    expect(turnout).toHaveLength(1);
    expect(turnout[0].member_id).toBe(m.memberId);
    expect(Object.keys(turnout[0]).sort()).toEqual(["contest_id", "last_day", "member_id", "revisions"]); // no ballot reference
    await w.ctx.events.flush();
    const ev = w.log.events.find((e: any) => e.type === "ballot.submitted")!.data;
    expect(Object.keys(ev).sort()).toEqual(["ballot_code", "ballot_id", "channel", "contest_id", "revision"]);
    expect(JSON.stringify(w.log.events)).not.toContain(m.memberId);
  });

  it("re-voting supersedes the earlier ballot; the new ballot is the only one counted; the platform cannot show what was chosen before", async () => {
    const w = await world();
    await w.ready();
    const m = w.ms[3];
    await w.vote(m, { [w.raceA]: w.a0, [w.raceB]: w.b0 });
    const second = await w.vote(m, { [w.raceA]: w.a1, [w.raceB]: null });
    expect(second.receipts[0].revision).toBe(2);
    const rows = await w.ctx.db.query<any>("SELECT superseded, nullifier FROM enc_ballots ORDER BY superseded");
    expect(rows.map((r: any) => r.superseded)).toEqual([false, true]);
    expect(new Set(rows.map((r: any) => r.nullifier)).size).toBe(1); // same person, same anonymous code
    expect((await w.ctx.db.query<any>("SELECT revisions FROM voted"))[0].revisions).toBe(2);
    const view = await election.ballotView(w.ctx, m.memberId, w.cid);
    expect(view).toMatchObject({ secret: true, voted: { revisions: 2 } });
    expect(view.races.every((r) => r.current === null)).toBe(true);
    // a different contest gives the same person a different nullifier
    expect(w.ctx.keys.refHash(`nullifier:${w.cid}`, m.memberId)).not.toBe(w.ctx.keys.refHash("nullifier:other", m.memberId));
  });

  it("needs every office answered; only members on the register; only while open", async () => {
    const w = await world();
    await w.appoint(); await w.ceremony(); await w.freeze(); await w.seal();
    expect(await code(w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: null }))).toBe("not_open");
    await w.open();
    const late = await joinAndActivate(w.ctx, w.agent); // joins after the register was frozen
    expect(await code(w.vote(w.ms[3], { [w.raceA]: w.a0 }))).toBe("bad_choice"); // a re-vote replaces the whole ballot, so it must be whole
    expect(await code(w.vote(w.ms[3], { [w.raceA]: w.b0, [w.raceB]: null }))).toBe("bad_choice"); // a candidate from another office
    expect(await code(w.vote(late, { [w.raceA]: w.a0, [w.raceB]: null }))).toBe("not_eligible"); // joined after the register was frozen
    expect(await code(w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: null }))).toBe("ok");
    await w.close();
    expect(await code(w.vote(w.ms[4], { [w.raceA]: w.a0, [w.raceB]: null }))).toBe("not_open");
  });

  it("works from all three channels and records the polling unit only for the agent's", async () => {
    const w = await world();
    await w.ready();
    await w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: null });
    await election.agentVote(w.ctx, w.agent, { phone: w.ms[4].phone, pin: PIN, contestId: w.cid, choices: { [w.raceA]: w.a1, [w.raceB]: w.b0 } });
    // USSD: office 1 candidate 1, office 2 candidate 1, confirm
    expect(await handleUssd(w.ctx, w.ms[5].phone, `5*${PIN}*1*1*1`)).toMatch(/^END Vote counted/);
    const rows = await w.ctx.db.query<any>("SELECT channel, unit FROM enc_ballots ORDER BY channel");
    expect(rows.map((r: any) => r.channel)).toEqual(["agent", "ussd", "web"]);
    expect(rows.find((r: any) => r.channel === "agent").unit).toMatch(/^PU-/);
    expect(rows.find((r: any) => r.channel === "web").unit).toBeNull();
    expect(rows.find((r: any) => r.channel === "ussd").unit).toBeNull();
  });
});

describe("counting: the guardians open the total, never a ballot", () => {
  it("results stay hidden until three of five guardians have posted their shares; two are not enough", async () => {
    const w = await world();
    const priv = await w.ready();
    await w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: w.b0 });
    await w.vote(w.ms[4], { [w.raceA]: w.a0, [w.raceB]: null });
    await w.vote(w.ms[5], { [w.raceA]: w.a1, [w.raceB]: w.b0 });
    await w.vote(w.ms[5], { [w.raceA]: w.a0, [w.raceB]: w.b0 }); // changed her mind: only this one counts
    expect(await code(sb.prepareTally(w.ctx, w.cid))).toBe("not_closed");
    await w.close();
    expect(await code(election.results(w.ctx, w.cid))).toBe("results_not_ready");
    expect(await sb.prepareTally(w.ctx, w.cid)).toEqual({ ballots: 3, prepared: true });
    expect(await sb.prepareTally(w.ctx, w.cid)).toEqual({ ballots: 3, prepared: false }); // idempotent

    expect(await w.openTally(priv, [w.ecs[0], w.ecs[1]])).toMatchObject({ shares: 2, opened: false });
    await expect(election.results(w.ctx, w.cid)).rejects.toMatchObject({ code: "results_not_ready", message: expect.stringContaining("2 of 3") });
    const out = await w.openTally(priv, [w.ecs[4]]); // a third, and the two who never showed up are not needed
    expect(out).toMatchObject({ shares: 3, opened: true });

    const res = await election.results(w.ctx, w.cid);
    const a = res.races.find((r: any) => r.raceId === w.raceA)!;
    expect(a).toMatchObject({ ballots: 3, abstained: 0, eligible: 8, winnerId: w.a0, tie: false });
    expect(a.candidates.find((c: any) => c.candidacyId === w.a0)!.votes).toBe(3);
    const b = res.races.find((r: any) => r.raceId === w.raceB)!;
    expect(b).toMatchObject({ ballots: 3, abstained: 1, winnerId: w.b0 });
    await w.ctx.events.flush();
    const types = w.log.events.map((e: any) => e.type);
    for (const t of ["tally.prepared", "tally.share_posted", "tally.opened", "race.turnout", "race.result"]) expect(types).toContain(t);
    expect(w.log.events.find((e: any) => e.type === "tally.opened")!.data).toMatchObject({ present: 3, absent: 2 });
  });

  it("only appointed guardians can post shares, once each, and only their own", async () => {
    const w = await world();
    const priv = await w.ready();
    await w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: null });
    await w.close(); await sb.prepareTally(w.ctx, w.cid);
    const rec = await sb.publicRecord(w.ctx, w.cid);
    const t = rec.tallies[0].tally;
    const mine = await w.eg.guardian.shares(priv[w.ecs[0].id], rec.manifest!, rec.context!, t, rec.publicKeys as string[]);
    const outsider = await makeAdmin(w.ctx, "electoral_committee");
    expect(await code(sb.submitShares(w.ctx, outsider, w.cid, "all", { ...mine, guardian_id: outsider.id }))).toBe("not_a_guardian");
    expect(await code(sb.submitShares(w.ctx, w.ecs[1], w.cid, "all", mine))).toBe("bad_submission"); // someone else's shares
    expect(await code(sb.submitShares(w.ctx, w.treasurer, w.cid, "all", mine))).toBe("forbidden");
    expect(await code(sb.submitShares(w.ctx, w.ecs[0], w.cid, "everything", mine))).toBe("bad_set");
    expect(await code(sb.submitShares(w.ctx, w.ecs[0], w.cid, "all", mine))).toBe("ok");
    expect(await code(sb.submitShares(w.ctx, w.ecs[0], w.cid, "all", mine))).toBe("already_posted");
  });

  it("the public record and the ballot list show the ciphertext and no identity, in code order not arrival order", async () => {
    const w = await world();
    await w.ready();
    for (const [i, m] of w.ms.slice(3, 8).entries()) await w.vote(m, { [w.raceA]: i % 2 ? w.a0 : w.a1, [w.raceB]: null });
    await w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: null });
    await w.close();
    const rec = await sb.publicRecord(w.ctx, w.cid);
    expect(rec).toMatchObject({ secretBallot: true, sealed: true, n: 5, quorum: 3, ballots: { submitted: 6, superseded: 1, counted: 5 } });
    const page1 = await sb.publicBallots(w.ctx, w.cid, undefined, 4);
    const page2 = await sb.publicBallots(w.ctx, w.cid, page1.next ?? undefined, 4);
    const all = [...page1.ballots, ...page2.ballots];
    expect(all).toHaveLength(6);
    expect(all.map((b) => b.ballotCode)).toEqual([...all.map((b) => b.ballotCode)].sort());
    expect(page2.next).toBeNull();
    expect(JSON.stringify(all)).not.toMatch(new RegExp(w.ms.map((m) => m.memberId).join("|")));
    expect(Object.keys(all[0]).sort()).toEqual(["ballot", "ballotCode", "castDay", "channel", "id", "proof", "superseded", "unit"]);
    expect((await sb.verifyRecord(w.ctx, w.cid).catch((e) => e)).code).toBe("nothing_to_verify"); // before the tally is prepared
    await sb.prepareTally(w.ctx, w.cid);
    expect((await sb.verifyRecord(w.ctx, w.cid)).ok).toBe(true);
  });
});

describe("paper at polling units audits the electronic count", () => {
  async function counted() {
    const w = await world();
    const priv = await w.ready();
    const asAgent = (m: any, a: string | null, b: string | null) => election.agentVote(w.ctx, w.agent, { phone: m.phone, pin: PIN, contestId: w.cid, choices: { [w.raceA]: a, [w.raceB]: b } });
    await asAgent(w.ms[3], w.a0, w.b0); await asAgent(w.ms[4], w.a0, null); await asAgent(w.ms[5], w.a1, w.b0);
    await w.vote(w.ms[6], { [w.raceA]: w.a1, [w.raceB]: null });
    await w.close();
    return { ...w, priv };
  }
  const units = (w: any) => w.ctx.db.query("SELECT unit, COUNT(*)::int AS n FROM enc_ballots WHERE channel='agent' GROUP BY unit") as Promise<{ unit: string; n: number }[]>;

  it("compares the number of paper ballots per unit with the electronic ballots cast there, and reports every gap", async () => {
    const w = await counted();
    const u = await units(w);
    expect(await code(sb.submitPaperCount(w.ctx, w.sec as any, { contestId: w.cid, unit: u[0].unit, ballots: 1, counts: [] }))).toBe("forbidden");
    const before = await sb.paperAudit(w.ctx, w.cid);
    expect(before.units.every((x) => x.status === "paper_missing")).toBe(true);
    expect(before.discrepancies).toBeGreaterThan(0);
    // unit A reports the right number, unit B a number that is one short
    for (const [i, x] of u.entries())
      await sb.submitPaperCount(w.ctx, w.agent, { contestId: w.cid, unit: x.unit, ballots: i === 0 ? x.n : x.n - 1, counts: [] });
    const audit = await sb.paperAudit(w.ctx, w.cid);
    if (u.length > 1) expect(audit.units.map((x) => x.status).sort()).toEqual(["match", "mismatch"]);
    else expect(audit.units[0].status).toBe("match");
    expect(await code(sb.submitPaperCount(w.ctx, w.agent, { contestId: w.cid, unit: u[0].unit, ballots: 99, counts: [] }))).toBe("paper_already"); // a report cannot be changed
  });

  it("compares choices too, once the guardians have opened the polling-unit total", async () => {
    const w = await counted();
    const u = (await units(w))[0];
    await sb.prepareTally(w.ctx, w.cid, "all"); await sb.prepareTally(w.ctx, w.cid, "agent");
    await sb.submitPaperCount(w.ctx, w.agent, {
      contestId: w.cid, unit: u.unit, ballots: 3,
      counts: [{ raceId: w.raceA, candidacyId: w.a0, n: 2 }, { raceId: w.raceA, candidacyId: w.a1, n: 1 }, { raceId: w.raceB, candidacyId: w.b0, n: 2 }, { raceId: w.raceB, candidacyId: null, n: 1 }],
    });
    await w.openTally(w.priv, w.ecs.slice(0, 3), "agent");
    const audit = await sb.paperAudit(w.ctx, w.cid);
    expect(audit.choices).not.toBeNull();
    expect(audit.choices!.filter((c) => !c.match)).toEqual([]);
    expect(audit.complete).toBe(true);
    // a paper count that disagrees with the electronic polling-unit total is reported, not smoothed over
    await w.ctx.db.query("UPDATE paper_counts SET n = n + 1 WHERE candidacy_id=$1", [w.a0]);
    const bad = await sb.paperAudit(w.ctx, w.cid);
    expect(bad.discrepancies).toBeGreaterThan(0);
    expect(bad.choices!.find((c) => c.candidacyId === w.a0)!.match).toBe(false);
  });

  it("rejects nonsense paper counts", async () => {
    const w = await counted();
    const u = (await units(w))[0].unit;
    const send = (o: any) => code(sb.submitPaperCount(w.ctx, w.agent, { contestId: w.cid, unit: u, ballots: 3, counts: [], ...o }));
    expect(await send({ unit: "<script>" })).toBe("bad_unit");
    expect(await send({ ballots: -1 })).toBe("bad_count");
    expect(await send({ counts: [{ raceId: w.raceA, candidacyId: w.a0, n: 4 }] })).toBe("bad_count"); // more votes than paper ballots
    expect(await send({ counts: [{ raceId: w.raceA, candidacyId: w.b0, n: 1 }] })).toBe("bad_choice"); // a candidate from the other office
  });
});
