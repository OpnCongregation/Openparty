import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Group } from "@semaphore-protocol/group";
import { Identity } from "@semaphore-protocol/identity";
import { generateProof } from "@semaphore-protocol/proof";
import { approve, propose } from "../src/admin.js";
import * as contests from "../src/contests.js";
import { DAY } from "../src/context.js";
import * as election from "../src/election.js";
import * as sb from "../src/secret-ballot.js";
import type { EgClient } from "../src/eg-client.js";
import { joinAndActivate, makeAdmin, setup } from "./helpers.js";
import { MockEg } from "./mock-eg.js";
import { messageOf, scopeOf } from "../src/semaphore.js";

export const PIN = "1234";

/** Tests use a small tree (depth 4, up to 16 voters) so proofs are quick. The pinned artifacts are fetched once if they are not already here. */
export const SEMAPHORE_DEPTH = 4;
const ART = join(dirname(fileURLToPath(import.meta.url)), "..", "semaphore-artifacts");
export function ensureArtifacts() {
  if (existsSync(join(ART, "semaphore-4.wasm")) && existsSync(join(ART, "semaphore-4.zkey"))) return;
  execFileSync("node", [join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "fetch-semaphore-artifacts.mjs"), "4"], { stdio: "inherit" });
}
export const artifacts = { wasm: join(ART, "semaphore-4.wasm"), zkey: join(ART, "semaphore-4.zkey") };

/** A contest with a notice, two offices, three candidates, eight members and the full cast of admins. Nothing is appointed or sealed yet. */
export async function world(eg: EgClient = new MockEg(), n = 8) {
  ensureArtifacts();
  const s = await setup({ eg, semaphore: { depth: SEMAPHORE_DEPTH, artifactsDir: ART } });
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
  /** Record the notice receipt, freeze the register and record its receipt. The group of voters is built from this register when the election is sealed. */
  let frozen = false;
  const freeze = async () => {
    if (frozen) return;
    await contests.recordNoticeReceipt(ctx, cid, "INEC-N-001");
    const f = await contests.freezeRegister(ctx, cid);
    await contests.recordRegisterReceipt(ctx, f.registerId, "INEC-R-001");
    frozen = true;
  };
  /** Wait for the vote date and open (freezing first if that has not been done). */
  const open = async () => {
    await freeze();
    s.advance(40);
    await contests.openContest(ctx, cid);
  };
  const ready = async () => { await appoint(); const priv = await ceremony(); await freeze(); await seal(); await open(); return priv; };

  /** A member makes an identity on their own device and registers its commitment. Returns the identity (the secret stays with the test, as it would on the phone). */
  const deviceIdentity = async (m: { phone: string }) => {
    const id = new Identity();
    await election.registerIdentity(ctx, { phone: m.phone, pin: PIN, commitment: id.commitment.toString() });
    return id;
  };
  /** An ANONYMOUS cast: a proof made from the public group, the choices, nothing that names the voter. */
  const castAs = async (id: Identity, choices: Record<string, string | null>, opts: { ballotId?: string; contestId?: string } = {}) => {
    const g = (await sb.publicGroup(ctx.db, cid))!;
    const ballotId = opts.ballotId ?? crypto.randomUUID();
    const proof = await generateProof(id, new Group(g.commitments.map(BigInt)), messageOf(ballotId), scopeOf(opts.contestId ?? cid), g.depth, artifacts);
    return { ballotId, proof, result: await sb.castAnonymous(ctx, { contestId: cid, ballotId, choices, proof }) };
  };
  const vote = (m: { phone: string }, choices: Record<string, string | null>) => election.webVote(ctx, { phone: m.phone, pin: PIN, contestId: cid, choices });
  const close = () => contests.closeContest(ctx, cid);
  const openTally = async (priv: Record<string, string>, who: any[], set: "all" | "agent" = "all") => {
    const rec = await sb.publicRecord(ctx, cid);
    const t = rec.tallies.find((x) => x.set === set)!.tally;
    let last: any;
    for (const g of who) last = await sb.submitShares(ctx, g, cid, set, await w.eg.guardian.shares(priv[g.id], rec.manifest!, rec.context!, t, rec.publicKeys as string[]));
    return last;
  };
  return { ...w, approved, appoint, ceremony, freeze, seal, open, ready, vote, close, openTally, deviceIdentity, castAs };
}
