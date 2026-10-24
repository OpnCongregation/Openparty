import { createHash } from "node:crypto";
import type { EgClient, ElectionSpec, Submission } from "../src/eg-client.js";
import { EgError } from "../src/eg-client.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const refuse = (m: string) => { throw new EgError(422, "refused", m); };

/**
 * A stand-in for the ElectionGuard service, for testing the PLATFORM's logic quickly (who may do what, what is stored, the order of steps).
 * It does no real cryptography: its "ciphertext" is just encoded. Everything about the real maths is tested in services/electionguard
 * and, end to end, by scripts/test-electionguard.mjs against the real service.
 */
export class MockEg implements EgClient {
  calls: string[] = [];
  async manifest(e: ElectionSpec) { this.calls.push("manifest"); if (!e.contests.length) refuse("an election needs at least one contest"); return { manifest: JSON.stringify(e), manifest_hash: sha(JSON.stringify(e)) }; }
  async combineKeys(keys: string[], n: number, _q: number) { if (keys.length !== n) refuse("wrong number of keys"); return { joint_public_key: sha(keys.join("|")) }; }
  async context(manifest: string, joint: string, n: number, quorum: number) { return { context: JSON.stringify({ mh: sha(manifest), joint, n, quorum }) }; }
  async encrypt(manifest: string, _ctx: string, ballotId: string, choices: Record<string, string | null>) {
    const spec = JSON.parse(manifest) as ElectionSpec;
    for (const [c, cand] of Object.entries(choices)) {
      const contest = spec.contests.find((x) => x.id === c) ?? refuse("that contest is not on this ballot");
      if (cand !== null && !contest.candidates.some((k) => k.id === cand)) refuse("that candidate is not on this ballot");
    }
    return { ballot: JSON.stringify({ id: ballotId, enc: Buffer.from(JSON.stringify(choices)).toString("base64") }), ballot_code: sha(ballotId) };
  }
  async checkBallot() { return true; }
  async tally(manifest: string, _c: string, ballots: string[], previous?: string) {
    const t: { counts: Record<string, Record<string, number>>; ids: string[] } = previous ? JSON.parse(previous) : { counts: {}, ids: [] };
    for (const raw of ballots) {
      const b = JSON.parse(raw) as { id: string; enc: string };
      if (t.ids.includes(b.id)) refuse("a ballot was refused by the tally (counted twice)");
      t.ids.push(b.id);
      const choices = JSON.parse(Buffer.from(b.enc, "base64").toString()) as Record<string, string | null>;
      for (const c of (JSON.parse(manifest) as ElectionSpec).contests) {
        t.counts[c.id] ??= Object.fromEntries(c.candidates.map((k) => [k.id, 0]));
        const v = choices[c.id];
        if (v) t.counts[c.id][v]++;
      }
    }
    if (!ballots.length && !previous) for (const c of (JSON.parse(manifest) as ElectionSpec).contests) t.counts[c.id] = Object.fromEntries(c.candidates.map((k) => [k.id, 0]));
    return { tally: JSON.stringify(t), added: ballots.length, count: t.ids.length };
  }
  async decrypt(_m: string, context: string, tally: string, publicKeys: string[], subs: Submission[]) {
    const { quorum } = JSON.parse(context) as { quorum: number };
    const owners = publicKeys.map((k) => (JSON.parse(k) as { owner_id: string }).owner_id);
    const present = [...new Set(subs.map((s) => s.guardian_id))];
    if (present.length !== subs.length) refuse("a guardian submitted twice");
    if (!present.every((p) => owners.includes(p))) refuse("a submission is from someone who is not a guardian");
    if (present.length < quorum) refuse(`need ${quorum} guardians; only ${present.length} took part`);
    return { counts: (JSON.parse(tally) as { counts: Record<string, Record<string, number>> }).counts, plaintext_tally: "{}", guardians_present: present.sort(), guardians_absent: owners.filter((o) => !present.includes(o)).sort() };
  }
  async verify(_m: string, _c: string, ballots: string[]) { return { ok: true, problems: [], ballots: ballots.length }; }

  guardian = {
    init: async (id: string, seq: number, n: number, quorum: number) => ({ private: JSON.stringify({ id, seq, n, quorum }), public: JSON.stringify({ owner_id: id, sequence_order: seq, key: `k-${id}` }) }),
    backups: async (priv: string, pubs: string[]) => {
      const me = JSON.parse(priv) as { id: string };
      const others = pubs.map((p) => JSON.parse(p).owner_id as string).filter((o) => o !== me.id);
      return { private: priv, backups: others.map((o) => JSON.stringify({ owner_id: me.id, designated_id: o })) };
    },
    receive: async (priv: string, backups: string[]) => {
      const me = JSON.parse(priv) as { id: string; n: number };
      const v = backups.map((b) => ({ from: JSON.parse(b).owner_id as string, verified: JSON.parse(b).designated_id === me.id }));
      return { private: priv, verifications: v, all_verified: v.length === me.n - 1 && v.every((x) => x.verified) };
    },
    shares: async (priv: string): Promise<Submission> => ({ guardian_id: (JSON.parse(priv) as { id: string }).id, share: "share", compensated: {} }),
  };
}
