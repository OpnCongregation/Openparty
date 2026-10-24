import { approve, propose } from "../src/admin.js";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import * as election from "../src/election.js";
import * as sb from "../src/secret-ballot.js";
import type { EgClient } from "../src/eg-client.js";
import { joinAndActivate, makeAdmin, setup } from "./helpers.js";
import { MockEg } from "./mock-eg.js";

export const PIN = "1234";

/** A contest with a notice, two offices, three candidates, eight members and the full cast of admins. Nothing is appointed or sealed yet. */
export async function world(eg: EgClient = new MockEg(), n = 8) {
  const s = await setup({ eg });
  const { ctx } = s;
  const agent = await makeAdmin(ctx, "ward_agent", "W1");
  const sec = await makeAdmin(ctx, "secretary");
  const aud = await makeAdmin(ctx, "auditor");
  const tri = await makeAdmin(ctx, "tribunal");
  const treasurer = await makeAdmin(ctx, "treasurer");
  const ecs = [];
  for (let i = 0; i < 5; i++) ecs.push(await makeAdmin(ctx, "electoral_committee"));
  const ms = [];
  for (let i = 0; i < n; i++) ms.push(await joinAndActivate(ctx, agent));
  const cid = await contests.createContest(ctx, { name: "Primary", primaryType: "direct", mode: "virtual", voteDate: new Date(ctx.clock().getTime() + 40 * DAY) });
  await contests.generateNotice(ctx, cid);
  const raceA = (await election.createRace(ctx, sec, { contestId: cid, office: "National Chairman" })).raceId;
  const raceB = (await election.createRace(ctx, sec, { contestId: cid, office: "Secretary" })).raceId;
  const stand = async (m: { phone: string }, race: string) => (await election.registerCandidate(ctx, { phone: m.phone, pin: PIN, raceId: race, consentPublic: true })).candidacyId;
  const a0 = await stand(ms[0], raceA), a1 = await stand(ms[1], raceA), b0 = await stand(ms[2], raceB);
  const w = { ...s, agent, sec, aud, tri, treasurer, ecs, ms, cid, raceA, raceB, a0, a1, b0, eg: eg as MockEg };

  const approved = async (action: string, payload: unknown, proposer: any, approvers: any[]) => {
    const id = await propose(ctx, proposer, action, payload);
    for (const a of approvers) await approve(ctx, a, id);
    return id;
  };
  const appoint = () => approved("guardians.appoint", { contestId: cid, adminIds: ecs.map((e) => e.id) }, sec, [aud, tri]);
  /** What each guardian does on their own device, using only public messages between them. */
  const ceremony = async () => {
    const priv: Record<string, string> = {};
    for (const [i, g] of ecs.entries()) {
      const k = await w.eg.guardian.init(g.id, i + 1, 5, 3);
      priv[g.id] = k.private;
      await sb.postKey(ctx, g, cid, k.public);
    }
    for (const g of ecs) {
      const v = await sb.ceremonyView(ctx, g, cid);
      const out = await w.eg.guardian.backups(priv[g.id], v.publicKeys);
      priv[g.id] = out.private;
      await sb.postBackups(ctx, g, cid, out.backups);
    }
    for (const g of ecs) {
      const v = await sb.ceremonyView(ctx, g, cid);
      const out = await w.eg.guardian.receive(priv[g.id], v.backupsForMe);
      priv[g.id] = out.private;
      await sb.postVerification(ctx, g, cid, out);
    }
    return priv;
  };
  const seal = () => approved("election.seal", { contestId: cid }, sec, [aud, tri]);
  /** Freeze the register, record both receipts, wait for the vote date and open. */
  const open = async () => {
    await contests.recordNoticeReceipt(ctx, cid, "INEC-N-001");
    const f = await contests.freezeRegister(ctx, cid);
    await contests.recordRegisterReceipt(ctx, f.registerId, "INEC-R-001");
    s.advance(40);
    await contests.openContest(ctx, cid);
  };
  const ready = async () => { await appoint(); const priv = await ceremony(); await seal(); await open(); return priv; };
  const vote = (m: { phone: string }, choices: Record<string, string | null>) => election.webVote(ctx, { phone: m.phone, pin: PIN, contestId: cid, choices });
  const close = () => contests.closeContest(ctx, cid);
  const openTally = async (priv: Record<string, string>, who: any[], set: "all" | "agent" = "all") => {
    const rec = await sb.publicRecord(ctx, cid);
    const t = rec.tallies.find((x) => x.set === set)!.tally;
    let last: any;
    for (const g of who) last = await sb.submitShares(ctx, g, cid, set, await w.eg.guardian.shares(priv[g.id], rec.manifest!, rec.context!, t, rec.publicKeys as string[]));
    return last;
  };
  return { ...w, approved, appoint, ceremony, seal, open, ready, vote, close, openTally };
}
