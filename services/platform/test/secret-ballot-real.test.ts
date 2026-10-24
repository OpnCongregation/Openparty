import { describe, expect, it } from "vitest";
import * as election from "../src/election.js";
import * as sb from "../src/secret-ballot.js";
import { HttpEgClient } from "../src/eg-client.js";
import { handleUssd } from "../src/ussd.js";
import { PIN, world } from "./sb-world.js";

// Runs against the REAL ElectionGuard service (scripts/test-electionguard.mjs starts a throwaway one). Skipped otherwise.
const URL = process.env.EG_TEST_URL;
const d = URL ? describe : describe.skip;

d("a whole secret-ballot election on the real ElectionGuard library", () => {
  it("five-guardian ceremony, encrypted votes by web, agent and USSD, a tally opened by 3 of 5 guardians, an independent check and a paper audit", async () => {
    const eg = new HttpEgClient(URL!, process.env.EG_TEST_TOKEN ?? "", { guardianOps: true });
    const w = await world(eg as any, 6);
    const priv = await w.ready(); // appoint, REAL distributed key ceremony, seal, freeze, open
    const keys = (await sb.keysOf(w.ctx.db, w.cid))!;
    expect(keys.manifest).toContain(w.raceA);
    expect(keys.joint_public_key.length).toBeGreaterThan(100);

    await w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: w.b0 });                                                  // web
    await election.agentVote(w.ctx, w.agent, { phone: w.ms[4].phone, pin: PIN, contestId: w.cid, choices: { [w.raceA]: w.a0, [w.raceB]: null } }); // polling unit
    // USSD: the option numbers follow the ballot order, which the test reads instead of assuming (registration times tie under a frozen test clock)
    const view = await election.ballotView(w.ctx, w.ms[5].memberId, w.cid);
    const opt = (race: string, cand: string) => view.races.find((r) => r.id === race)!.candidates.findIndex((c) => c.id === cand) + 1;
    expect(await handleUssd(w.ctx, w.ms[5].phone, `5*${PIN}*${opt(w.raceA, w.a1)}*${opt(w.raceB, w.b0)}*1`)).toMatch(/^END Vote counted/);
    await w.vote(w.ms[3], { [w.raceA]: w.a0, [w.raceB]: w.b0 });                                                  // and a re-vote

    // what is stored is real ciphertext with no vote and no member in it
    const stored = await w.ctx.db.query<{ ballot: string }>("SELECT ballot FROM enc_ballots");
    expect(stored).toHaveLength(4);
    for (const r of stored) {
      expect(r.ballot).toContain("ciphertext");
      for (const m of w.ms) expect(r.ballot).not.toContain(m.memberId);
    }

    await w.close();
    expect(await sb.prepareTally(w.ctx, w.cid, "all")).toEqual({ ballots: 3, prepared: true });
    expect(await sb.prepareTally(w.ctx, w.cid, "agent")).toEqual({ ballots: 1, prepared: true });
    const verified = await sb.verifyRecord(w.ctx, w.cid);
    expect(verified).toMatchObject({ ok: true, ballots: 3 });

    // only three of the five guardians show up; two never do
    const out = await w.openTally(priv as any, [w.ecs[0], w.ecs[2], w.ecs[4]]);
    expect(out).toMatchObject({ shares: 3, opened: true });
    const res = await election.results(w.ctx, w.cid);
    const a = res.races.find((r: any) => r.raceId === w.raceA)!;
    expect(a.candidates.find((c: any) => c.candidacyId === w.a0)!.votes).toBe(2);
    expect(a.candidates.find((c: any) => c.candidacyId === w.a1)!.votes).toBe(1);
    expect(a.winnerId).toBe(w.a0);
    const b = res.races.find((r: any) => r.raceId === w.raceB)!;
    expect(b.candidates.find((c: any) => c.candidacyId === w.b0)!.votes).toBe(2);
    expect(b.abstained).toBe(1);
    await w.ctx.events.flush();
    expect(w.log.events.find((e: any) => e.type === "tally.opened")!.data).toMatchObject({ present: 3, absent: 2 });
    expect(JSON.stringify(w.log.events)).not.toContain(w.ms[3].memberId);

    // the paper kept at the polling unit agrees with the electronic polling-unit total
    const unit = (await w.ctx.db.query<{ unit: string }>("SELECT unit FROM enc_ballots WHERE channel='agent'"))[0].unit;
    await sb.submitPaperCount(w.ctx, w.agent, { contestId: w.cid, unit, ballots: 1, counts: [{ raceId: w.raceA, candidacyId: w.a0, n: 1 }, { raceId: w.raceB, candidacyId: null, n: 1 }] });
    await w.openTally(priv as any, [w.ecs[1], w.ecs[2], w.ecs[3]], "agent");
    const audit = await sb.paperAudit(w.ctx, w.cid);
    expect(audit.units[0].status).toBe("match");
    expect(audit.choices!.every((c) => c.match)).toBe(true);
    expect(audit.complete).toBe(true);
  }, 900_000);
});
