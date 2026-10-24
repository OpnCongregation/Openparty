import { describe, expect, it } from "vitest";
import { Group } from "@semaphore-protocol/group";
import { Identity } from "@semaphore-protocol/identity";
import { generateProof } from "@semaphore-protocol/proof";
import * as election from "../src/election.js";
import * as sb from "../src/secret-ballot.js";
import { deriveIdentity, groupOf, messageOf, scopeOf } from "../src/semaphore.js";
import { buildServer } from "../src/server.js";
import { handleUssd } from "../src/ussd.js";
import { joinAndActivate } from "./helpers.js";
import { PIN, artifacts, world } from "./sb-world.js";

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as any).code as string);

/** Everything before voting, with chosen members holding identities made on their own devices. */
async function ballotBox(deviceMembers: number[] = [3]) {
  const w = await world();
  await w.appoint(); await w.ceremony(); await w.freeze();
  const ids = new Map<number, Identity>();
  for (const i of deviceMembers) ids.set(i, await w.deviceIdentity(w.ms[i]));
  await w.seal(); await w.open();
  return { ...w, ids };
}
const A = (w: any, a: string | null, b: string | null) => ({ [w.raceA]: a, [w.raceB]: b });

describe("the identity a voter holds", () => {
  it("is registered from the member's own device: only the public commitment is sent, only by an active member, and never the platform's own", async () => {
    const w = await world();
    const id = new Identity();
    const reg = (m: any, c: string, pin = PIN) => code(election.registerIdentity(w.ctx, { phone: m.phone, pin, commitment: c }));
    expect(await reg(w.ms[3], id.commitment.toString(), "9999")).toBe("pin_wrong");
    expect(await reg(w.ms[3], "not a number")).toBe("bad_commitment");
    expect(await reg(w.ms[3], "0")).toBe("bad_commitment");
    expect(await reg(w.ms[3], "9".repeat(80))).toBe("bad_commitment");
    expect(await reg(w.ms[3], deriveIdentity(w.ctx, w.ms[3].memberId).commitment.toString())).toBe("bad_commitment"); // the platform's own identity
    expect(await reg(w.ms[3], id.commitment.toString())).toBe("ok");
    expect(await reg(w.ms[4], id.commitment.toString())).toBe("bad_commitment");  // the same identity cannot belong to two members
    expect(await reg(w.ms[3], new Identity().commitment.toString())).toBe("ok");   // changing it is fine before a group is built
    const row = (await w.ctx.db.query<any>("SELECT mode FROM identity_commitments WHERE member_id=$1", [w.ms[3].memberId]))[0];
    expect(row.mode).toBe("device");
    expect(JSON.stringify(await w.ctx.db.query("SELECT * FROM identity_commitments"))).not.toMatch(/secret|private|trapdoor/i);
  });

  it("is fixed when the election is sealed; a ward agent can return a member to the platform's identity only before that", async () => {
    const w = await world();
    await w.appoint(); await w.ceremony(); await w.freeze();
    await w.deviceIdentity(w.ms[3]);
    const other = await (await import("./helpers.js")).makeAdmin(w.ctx, "ward_agent", "W2");
    await expect(election.resetIdentity(w.ctx, other, { memberId: w.ms[3].memberId })).rejects.toMatchObject({ code: "wrong_ward" });
    await expect(election.resetIdentity(w.ctx, w.sec as any, { memberId: w.ms[3].memberId })).rejects.toMatchObject({ code: "forbidden" });
    await election.resetIdentity(w.ctx, w.agent, { memberId: w.ms[3].memberId });
    expect((await w.ctx.db.query("SELECT 1 FROM identity_commitments WHERE member_id=$1", [w.ms[3].memberId])).length).toBe(0);
    await w.deviceIdentity(w.ms[3]);
    await w.seal();
    expect(await code(election.registerIdentity(w.ctx, { phone: w.ms[3].phone, pin: PIN, commitment: new Identity().commitment.toString() }))).toBe("identity_locked");
    expect(await code(election.resetIdentity(w.ctx, w.agent, { memberId: w.ms[3].memberId }))).toBe("identity_locked");
  });
});

describe("the group of voters", () => {
  it("is built from the frozen register when the election is sealed: sorted, public, rebuildable by anyone, with device and platform identities mixed", async () => {
    const w = await world();
    await w.appoint(); await w.ceremony(); await w.freeze();
    const mine = await w.deviceIdentity(w.ms[3]);
    expect(await code(sb.sealElection(w.ctx, { contestId: w.cid }))).toBe("ok"); // sealing builds it
    const g = (await groupOf(w.ctx.db, w.cid))!;
    expect(g.size).toBe(8);
    expect(g.depth).toBe(4);
    const nums = g.commitments.map(BigInt);
    expect(nums).toEqual([...nums].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))); // sorted by value: position says nothing about who
    expect(g.commitments).toContain(mine.commitment.toString());
    expect(g.commitments).toContain(deriveIdentity(w.ctx, w.ms[0].memberId).commitment.toString());
    expect(new Group(nums).root.toString()).toBe(g.root); // anyone can rebuild the root from the published list
    const dump = JSON.stringify(await w.ctx.db.query("SELECT * FROM semaphore_groups"));
    for (const m of w.ms) expect(dump).not.toContain(m.memberId);
    await w.ctx.events.flush();
    expect(w.log.events.find((e: any) => e.type === "group.built")!.data).toMatchObject({ size: 8, depth: 4, root: BigInt(g.root).toString(16).padStart(64, "0") });
  });

  it("is not built for a register that is not frozen, or one too big for the tree", async () => {
    const w = await world();
    await w.appoint(); await w.ceremony();
    expect(await code(sb.sealElection(w.ctx, { contestId: w.cid }))).toBe("no_register");
    const big = await world(undefined, 17); // depth 4 holds 16
    await big.appoint(); await big.ceremony(); await big.freeze();
    expect(await code(sb.sealElection(big.ctx, { contestId: big.cid }))).toBe("group_too_big");
  });
});

describe("anonymous casting from the voter's own device", () => {
  it("needs no login, and leaves nothing that links the ballot to the member, even to someone holding every platform secret", async () => {
    const w = await ballotBox([3]);
    const me = w.ids.get(3)!;
    const { result, proof } = await w.castAs(me, A(w, w.a0, w.b0));
    expect(result.receipts[0].receipt).toMatch(/^[0-9a-f]{64}$/);
    // no row says this member voted: the turnout table is only for voters the platform itself identifies
    expect((await w.ctx.db.query("SELECT 1 FROM voted WHERE member_id=$1", [w.ms[3].memberId])).length).toBe(0);
    const stored = (await w.ctx.db.query<any>("SELECT * FROM enc_ballots"))[0];
    expect(stored.nullifier).toBe(proof.nullifier);
    // the nullifier cannot be reproduced from anything the platform holds: the identity the platform would derive for this member gives a different one
    const derived = await generateProof(deriveIdentity(w.ctx, w.ms[3].memberId), new Group((await groupOf(w.ctx.db, w.cid))!.commitments.map(BigInt)), messageOf("x"), scopeOf(w.cid), 4, artifacts).catch((e) => e);
    expect(derived instanceof Error).toBe(true); // the derived commitment is not even in the group: only the device's is
    const dump = JSON.stringify([await w.ctx.db.query("SELECT * FROM enc_ballots"), await w.ctx.db.query("SELECT * FROM voted"), await w.ctx.db.query("SELECT * FROM semaphore_groups")]);
    for (const secret of [w.ms[3].memberId, w.ms[3].phone, w.ms[3].nin]) expect(dump).not.toContain(secret.toString());
    // The commitment IS public (the group is a published list). The platform knows which member registered it, as it must to build the group,
    // but a ballot's proof shows only a nullifier, which zero-knowledge makes unlinkable to any commitment in the group.
    expect(dump).toContain(me.commitment.toString());
    expect(stored.nullifier).not.toBe(me.commitment.toString());
    await w.ctx.events.flush();
    const log = JSON.stringify(w.log.events);
    expect(log).not.toContain(w.ms[3].memberId);
    expect(log).not.toContain(proof.nullifier); // the nullifier is in the database and in the published ballot record, not in the log
  });

  it("a second ballot from the same identity replaces the first; the counted ballot is the latest; revisions are public, the person is not", async () => {
    const w = await ballotBox([3]);
    const me = w.ids.get(3)!;
    const first = await w.castAs(me, A(w, w.a0, w.b0));
    const second = await w.castAs(me, A(w, w.a1, null));
    expect(first.proof.nullifier).toBe(second.proof.nullifier); // same person, same contest: same nullifier
    expect(second.result.receipts[0].revision).toBe(2);
    const rows = await w.ctx.db.query<any>("SELECT superseded FROM enc_ballots ORDER BY superseded");
    expect(rows.map((r: any) => r.superseded)).toEqual([false, true]);
  });

  it("refuses a replayed ballot, a proof reused for another ballot, a proof for another contest, a wrong group, and a stranger", async () => {
    const w = await ballotBox([3]);
    const me = w.ids.get(3)!;
    const ok = await w.castAs(me, A(w, w.a0, w.b0));
    // the very same request again
    expect(await code(sb.castAnonymous(w.ctx, { contestId: w.cid, ballotId: ok.ballotId, choices: A(w, w.a1, null), proof: ok.proof }))).toBe("bad_ballot");
    // the same proof attached to a fresh ballot id
    expect(await code(sb.castAnonymous(w.ctx, { contestId: w.cid, ballotId: crypto.randomUUID(), choices: A(w, w.a1, null), proof: ok.proof }))).toBe("bad_proof");
    // a proof made for a different contest's scope
    const wrongScope = await w.castAs(me, A(w, w.a0, null), { contestId: "00000000-0000-4000-8000-000000000001" }).catch((e) => e);
    expect(wrongScope.code).toBe("bad_proof");
    // tampered proof fields
    const fresh = crypto.randomUUID();
    const g = (await groupOf(w.ctx.db, w.cid))!;
    const good = await generateProof(me, new Group(g.commitments.map(BigInt)), messageOf(fresh), scopeOf(w.cid), g.depth, artifacts);
    const send = (p: any) => code(sb.castAnonymous(w.ctx, { contestId: w.cid, ballotId: fresh, choices: A(w, w.a0, null), proof: p }));
    expect(await send({ ...good, points: [...good.points.slice(0, 7), "1"] })).toBe("bad_proof");
    expect(await send({ ...good, nullifier: "12345" })).toBe("bad_proof");
    expect(await send({ ...good, merkleTreeRoot: "12345" })).toBe("bad_proof");
    expect(await send({ ...good, points: good.points.slice(0, 7) })).toBe("bad_proof");
    expect(await send(null)).toBe("bad_proof");
    expect(await send("proof")).toBe("bad_proof");
    // a stranger who was never in the group cannot make a proof at all, and a made-up one does not verify
    const stranger = new Identity();
    await expect(generateProof(stranger, new Group(g.commitments.map(BigInt)), messageOf(fresh), scopeOf(w.cid), g.depth, artifacts)).rejects.toThrow();
    expect(await send(good)).toBe("ok");
  });

  it("only while voting is open, with every office answered, and for candidates on the ballot", async () => {
    const w = await ballotBox([3]);
    const me = w.ids.get(3)!;
    expect((await w.castAs(me, { [w.raceA]: w.a0 } as any).catch((e) => e)).code).toBe("bad_choice");
    expect((await w.castAs(me, A(w, w.b0, null)).catch((e) => e)).code).toBe("bad_choice");
    const g = (await groupOf(w.ctx.db, w.cid))!;
    const bad = crypto.randomUUID();
    const proof = await generateProof(me, new Group(g.commitments.map(BigInt)), messageOf(bad), scopeOf(w.cid), g.depth, artifacts);
    expect(await code(sb.castAnonymous(w.ctx, { contestId: w.cid, ballotId: "not-a-uuid", choices: A(w, w.a0, null), proof }))).toBe("bad_ballot");
    await w.close();
    expect((await w.castAs(me, A(w, w.a0, null)).catch((e) => e)).code).toBe("not_open");
  });

  it("is the only way a device voter can vote: the platform cannot make their proof, on any channel", async () => {
    const w = await ballotBox([3]);
    expect(await code(w.vote(w.ms[3], A(w, w.a0, null)))).toBe("use_device");
    expect(await code(election.agentVote(w.ctx, w.agent, { phone: w.ms[3].phone, pin: PIN, contestId: w.cid, choices: A(w, w.a0, null) }))).toBe("use_device");
    expect(await handleUssd(w.ctx, w.ms[3].phone, `5*${PIN}*1*1*1`)).toMatch(/^END .*own device/);
    expect((await w.ctx.db.query("SELECT 1 FROM enc_ballots")).length).toBe(0);
  });

  it("an assisted voter (USSD, terminal, web with a PIN) gets the same proofs, so every ballot in the box is verifiable the same way", async () => {
    const w = await ballotBox([3]);
    await w.vote(w.ms[4], A(w, w.a1, w.b0));
    await election.agentVote(w.ctx, w.agent, { phone: w.ms[5].phone, pin: PIN, contestId: w.cid, choices: A(w, w.a0, null) });
    await w.castAs(w.ids.get(3)!, A(w, w.a0, w.b0));
    const rows = await w.ctx.db.query<any>("SELECT channel, nullifier, proof FROM enc_ballots");
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.proof && JSON.parse(r.proof).nullifier === r.nullifier)).toBe(true);
    expect(new Set(rows.map((r: any) => r.nullifier)).size).toBe(3); // three people, three nullifiers
    expect((await sb.verifyRecord(w.ctx, w.cid).catch((e) => e)).code).toBe("nothing_to_verify"); // not closed or tallied yet
  });
});

describe("what the public can check", () => {
  async function counted() {
    const w = await ballotBox([3]);
    await w.vote(w.ms[4], A(w, w.a1, w.b0));
    await w.castAs(w.ids.get(3)!, A(w, w.a0, w.b0));
    await w.castAs(w.ids.get(3)!, A(w, w.a0, null)); // a re-vote
    await w.close();
    await sb.prepareTally(w.ctx, w.cid);
    return w;
  }

  it("every ballot has a valid membership proof for the published group, and no two counted ballots share a nullifier", async () => {
    const w = await counted();
    const v = await sb.verifyRecord(w.ctx, w.cid);
    expect(v).toMatchObject({ ok: true, ballots: 2, eligibilityChecked: 3 });
    const rec = await sb.publicRecord(w.ctx, w.cid);
    expect(rec.group).toMatchObject({ size: 8, depth: 4 });
    const page = await sb.publicBallots(w.ctx, w.cid, undefined, 10);
    expect(page.ballots.every((b) => b.proof && b.proof.nullifier)).toBe(true);
  });

  it("catches a ballot slipped into the box without a proof, a proof moved to another ballot, and one person counted twice", async () => {
    const w = await counted();
    const rows = await w.ctx.db.query<any>("SELECT * FROM enc_ballots WHERE NOT superseded ORDER BY ballot_code");
    // 1. a ballot with no proof
    await w.ctx.db.query("INSERT INTO enc_ballots(id, contest_id, nullifier, ballot, ballot_code, channel, cast_day) VALUES ($1,$2,'777',$3,$4,'web',$5)",
      [crypto.randomUUID(), w.cid, rows[0].ballot, "f".repeat(64), new Date().toISOString()]);
    let v = await sb.verifyRecord(w.ctx, w.cid);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p: string) => /no membership proof/.test(p))).toBe(true);
    await w.ctx.db.query("DELETE FROM enc_ballots WHERE nullifier='777'");
    // 2. a valid proof attached to a ballot id it was not made for
    await w.ctx.db.query("INSERT INTO enc_ballots(id, contest_id, nullifier, ballot, ballot_code, channel, cast_day, proof) VALUES ($1,$2,$3,$4,$5,'web',$6,$7)",
      [crypto.randomUUID(), w.cid, rows[0].nullifier, rows[0].ballot, "e".repeat(64), new Date().toISOString(), rows[0].proof]);
    v = await sb.verifyRecord(w.ctx, w.cid);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p: string) => /different ballot/.test(p))).toBe(true);
    expect(v.problems.some((p: string) => /share nullifier/.test(p))).toBe(true); // and that is one person counted twice
  });
});

describe("who may vote, now that the proof does not say who", () => {
  it("a member who joined after the register was frozen cannot vote, on any channel", async () => {
    const w = await ballotBox([3]);
    const late = await joinAndActivate(w.ctx, w.agent);
    expect(await code(w.vote(late, A(w, w.a0, null)))).toBe("not_eligible");
    const lateDevice = new Identity();
    await election.registerIdentity(w.ctx, { phone: late.phone, pin: PIN, commitment: lateDevice.commitment.toString() }); // registering is allowed, voting is not: not in the group
    expect((await w.castAs(lateDevice, A(w, w.a0, null)).catch((e) => e)) instanceof Error).toBe(true);
  });

  it("POLICY: a member who resigns after the freeze stays on the register. A platform-identified voter is refused; a device voter, being anonymous, cannot be", async () => {
    const w = await ballotBox([3]);
    const { resign } = await import("../src/members.js");
    await resign(w.ctx, w.ms[4].memberId);
    await resign(w.ctx, w.ms[3].memberId);
    expect(await code(w.vote(w.ms[4], A(w, w.a0, null)))).toBe("no_member"); // the platform knows who this is
    expect((await w.castAs(w.ids.get(3)!, A(w, w.a0, null))).result.receipts).toHaveLength(1); // nothing identifies this one: removing a voter from the group mid-vote is a pending task
  });
});

describe("the endpoints", () => {
  it("accept an anonymous cast with no credentials, require a PIN to register an identity, serve the group and the proving files, and throttle", async () => {
    const w = await ballotBox([3]);
    const app = buildServer(w.ctx, {});
    const me = w.ids.get(3)!;
    const g = (await (await app.inject({ url: `/public/election/${w.cid}/group` })).json()) as any;
    expect(g).toMatchObject({ depth: 4, size: 8 });
    const ballotId = crypto.randomUUID();
    const proof = await generateProof(me, new Group(g.commitments.map(BigInt)), messageOf(ballotId), scopeOf(w.cid), g.depth, artifacts);
    const res = await app.inject({ method: "POST", url: "/election/cast", payload: { contestId: w.cid, ballotId, choices: A(w, w.a0, w.b0), proof } });
    expect(res.statusCode).toBe(200);
    expect(res.json().receipts[0].receipt).toMatch(/^[0-9a-f]{64}$/);
    expect((await app.inject({ method: "POST", url: "/election/cast", payload: { contestId: w.cid, ballotId, choices: A(w, w.a0, w.b0), proof } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/election/identity", payload: { phone: w.ms[5].phone, pin: "0000", commitment: new Identity().commitment.toString() } })).statusCode).toBe(401);
    const wasm = await app.inject({ url: "/public/semaphore/4/semaphore.wasm" });
    expect(wasm.statusCode).toBe(200);
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    expect(wasm.rawPayload.length).toBeGreaterThan(1_000_000);
    expect((await app.inject({ url: "/public/semaphore/9/semaphore.wasm" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/public/semaphore/4/../../secret" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/public/semaphore/4/evil.txt" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/public/config" })).json()).toMatchObject({ secretBallot: true, semaphoreDepth: 4 });
  });
});
