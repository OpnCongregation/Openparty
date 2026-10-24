import { createHash, randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import type { Db } from "./db.js";
import { fail } from "./errors.js";
import { require_, type Admin } from "./admin.js";
import type { EgClient, Submission } from "./eg-client.js";

/**
 * The secret ballot (phases 2 and 3 of docs/secret-ballot-recommendation.md), on top of the ElectionGuard service.
 *
 * Who holds what:
 *  - FIVE GUARDIANS, all members of the electoral committee (for the contest's country, state or municipality), each hold a key share.
 *    Any THREE can open the TOTAL. Nobody can open a single ballot with fewer than three, and no guardian key ever reaches this platform:
 *    guardians make and keep their keys on their own device (services/electionguard guardian_tool) and send only public messages here.
 *  - The platform stores ciphertext ballots with NO member id: only an anonymous nullifier and a day, so a stolen database does not say
 *    who voted for whom. The member is recorded separately as "has voted" (turnout), with no link to a ballot.
 *
 * Honest limits (see docs): the nullifier is a keyed hash, so someone holding the platform's secret key AND the database can re-derive
 * which ballot belongs to a member; the zero-knowledge membership proof that removes that is not built yet. Ballots from USSD and agent
 * voters are encrypted on the server, so the choice passes through server memory once. And all five guardians being electoral-committee
 * members concentrates trust: three colluding members could open individual (anonymous) ballots.
 */

export const GUARDIANS = 5;
export const QUORUM = 3;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const UNIT = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,39}$/;

export function egOf(ctx: Ctx): EgClient {
  return ctx.eg ?? fail("secret_ballot_unavailable", "The ballot-encryption service is not configured on this platform", 503);
}

interface ContestRow { id: string; name: string; state: string; vote_date: string; jurisdiction: string | null }
async function contest(db: Db, id: string): Promise<ContestRow> {
  const r = await db.query<ContestRow>("SELECT id, name, state, vote_date, jurisdiction FROM contests WHERE id=$1", [id]);
  return r.length ? r[0] : fail("not_found", "No such contest", 404);
}

export interface KeysRow { contest_id: string; n: number; quorum: number; joint_public_key: string; manifest: string | null; manifest_hash: string | null; context: string | null; sealed_at: string | null }
export async function keysOf(db: Db, contestId: string): Promise<KeysRow | null> {
  return (await db.query<KeysRow>("SELECT * FROM election_keys WHERE contest_id=$1", [contestId]))[0] ?? null;
}
/** True once the guardians' keys are combined AND the ballot description is fixed. From then on offices and candidates cannot change. */
export async function isSealed(db: Db, contestId: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM election_keys WHERE contest_id=$1 AND sealed_at IS NOT NULL", [contestId]);
  return r.length > 0;
}

// ---- Guardians ------------------------------------------------------------------------------------------------------

/**
 * Appoint the five guardians for a contest. They must be five different active electoral-committee admins, and, when the contest names a
 * jurisdiction (a country, state or municipality), members of the electoral committee of THAT jurisdiction. Runs as an approved action.
 */
export async function appointGuardians(ctx: Ctx, input: { contestId: string; adminIds: string[] }) {
  const c = await contest(ctx.db, input.contestId);
  if (c.state !== "draft" && c.state !== "noticed") return fail("bad_state", "Guardians are appointed before voting opens", 409);
  if (await keysOf(ctx.db, c.id)) return fail("already_keyed", "This contest already has its election keys", 409);
  if (!Array.isArray(input.adminIds) || input.adminIds.length !== GUARDIANS || new Set(input.adminIds).size !== GUARDIANS)
    return fail("bad_guardians", `Appoint exactly ${GUARDIANS} different people`, 422);
  const rows = await ctx.db.query<{ id: string; role: string; active: boolean; jurisdiction: string | null; name: string }>(
    "SELECT id, role, active, jurisdiction, name FROM admins WHERE id = ANY($1)", [input.adminIds]);
  if (rows.length !== GUARDIANS) return fail("bad_guardians", "One of those people is not an admin", 422);
  for (const a of rows) {
    if (!a.active) return fail("bad_guardians", `${a.name} is not active`, 422);
    if (a.role !== "electoral_committee") return fail("bad_guardians", `${a.name} is not on the electoral committee`, 422);
    if (c.jurisdiction && a.jurisdiction !== c.jurisdiction) return fail("bad_guardians", `${a.name} is not on the electoral committee for ${c.jurisdiction}`, 422);
  }
  await ctx.commit(async (tx) => {
    if ((await tx.query("SELECT 1 FROM guardians WHERE contest_id=$1 LIMIT 1", [c.id])).length) return fail("already_appointed", "Guardians are already appointed", 409);
    for (let i = 0; i < GUARDIANS; i++) await tx.query("INSERT INTO guardians(contest_id, admin_id, position) VALUES ($1,$2,$3)", [c.id, input.adminIds[i], i + 1]);
    await ctx.events.emit(tx, { type: "guardians.appointed", data: { contest_id: c.id, n: GUARDIANS, quorum: QUORUM } });
  });
}

interface GuardianRow { contest_id: string; admin_id: string; position: number; public_key: string | null; backups: string | null; verified: boolean | null }
const guardiansOf = (db: Db, contestId: string) => db.query<GuardianRow>("SELECT contest_id, admin_id, position, public_key, backups, verified FROM guardians WHERE contest_id=$1 ORDER BY position", [contestId]);

async function me(db: Db, admin: Admin, contestId: string): Promise<GuardianRow> {
  const r = (await guardiansOf(db, contestId)).find((g) => g.admin_id === admin.id);
  return r ?? fail("not_a_guardian", "You are not a guardian of this contest", 403);
}

/** What a guardian needs to take their next step in the key ceremony. All of it is public except what they themselves hold. */
export async function ceremonyView(ctx: Ctx, admin: Admin, contestId: string) {
  require_(admin, "guardian.act");
  const all = await guardiansOf(ctx.db, contestId);
  const mine = all.find((g) => g.admin_id === admin.id) ?? fail("not_a_guardian", "You are not a guardian of this contest", 403);
  const keysPosted = all.every((g) => g.public_key);
  const backupsPosted = all.every((g) => g.backups);
  const forMe = backupsPosted
    ? all.filter((g) => g.admin_id !== admin.id).flatMap((g) => (JSON.parse(g.backups!) as string[]).filter((b) => JSON.parse(b).designated_id === admin.id))
    : [];
  const done = !!(await keysOf(ctx.db, contestId));
  const posted = await ctx.db.query<{ tally_set: string }>("SELECT tally_set FROM guardian_shares WHERE contest_id=$1 AND admin_id=$2", [contestId, admin.id]);
  const step = !mine.public_key ? "post_key" : !keysPosted ? "wait_for_keys" : !mine.backups ? "post_backups" : !backupsPosted ? "wait_for_backups" : mine.verified === null ? "verify" : !done ? "wait_for_verifications" : "complete";
  return {
    contestId, position: mine.position, n: GUARDIANS, quorum: QUORUM, step,
    sharesPosted: Object.fromEntries(["all", "agent"].map((k) => [k, posted.some((p) => p.tally_set === k)])) as Record<string, boolean>,
    guardians: all.map((g) => ({ adminId: g.admin_id, position: g.position, keyPosted: !!g.public_key, backupsPosted: !!g.backups, verified: g.verified })),
    publicKeys: keysPosted ? all.map((g) => g.public_key!) : [],
    backupsForMe: forMe,
  };
}

const parse = (raw: unknown, what: string): any => {
  try { return JSON.parse(String(raw)); } catch { return fail("bad_input", `${what} is not valid JSON`, 422); }
};

/** Step 1: post your PUBLIC key (made on your own device). */
export async function postKey(ctx: Ctx, admin: Admin, contestId: string, publicKey: string) {
  require_(admin, "guardian.act");
  const k = parse(publicKey, "The public key");
  await ctx.commit(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ceremony:${contestId}`]);
    const g = await me(tx, admin, contestId);
    if (await keysOf(tx, contestId)) return fail("already_keyed", "The ceremony is finished", 409);
    if (g.public_key) return fail("already_posted", "You already posted your key", 409);
    if (k.owner_id !== admin.id || Number(k.sequence_order) !== g.position) return fail("bad_key", "That key was made for a different guardian or position", 422);
    await tx.query("UPDATE guardians SET public_key=$3 WHERE contest_id=$1 AND admin_id=$2", [contestId, admin.id, publicKey]);
    await ctx.events.emit(tx, { type: "guardian.key_posted", data: { contest_id: contestId, admin_id: admin.id, position: g.position } });
  });
}

/** Step 2 (after all five keys are in): post the encrypted backups you made, one for each other guardian. */
export async function postBackups(ctx: Ctx, admin: Admin, contestId: string, backups: string[]) {
  require_(admin, "guardian.act");
  await ctx.commit(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ceremony:${contestId}`]);
    const all = await guardiansOf(tx, contestId);
    const g = all.find((x) => x.admin_id === admin.id) ?? fail("not_a_guardian", "You are not a guardian of this contest", 403);
    if (!all.every((x) => x.public_key)) return fail("wait", "All five guardians must post their keys first", 409);
    if (g.backups) return fail("already_posted", "You already posted your backups", 409);
    if (!Array.isArray(backups) || backups.length !== GUARDIANS - 1) return fail("bad_backups", `Post exactly ${GUARDIANS - 1} backups`, 422);
    const others = new Set(all.filter((x) => x.admin_id !== admin.id).map((x) => x.admin_id));
    const seen = new Set<string>();
    for (const raw of backups) {
      const b = parse(raw, "A backup");
      if (b.owner_id !== admin.id || !others.has(b.designated_id) || seen.has(b.designated_id)) return fail("bad_backups", "Each backup must be from you, for a different other guardian", 422);
      seen.add(b.designated_id);
    }
    await tx.query("UPDATE guardians SET backups=$3 WHERE contest_id=$1 AND admin_id=$2", [contestId, admin.id, JSON.stringify(backups)]);
  });
}

/**
 * Step 3: confirm you checked the backups addressed to you. When all five confirm, the platform combines the five public keys into the
 * election key (public maths anyone can repeat) and the ceremony is complete.
 */
export async function postVerification(ctx: Ctx, admin: Admin, contestId: string, input: { all_verified: boolean; verifications: { from: string; verified: boolean }[] }) {
  require_(admin, "guardian.act");
  const eg = egOf(ctx);
  let joint: { keys: string[] } | null = null;
  await ctx.commit(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ceremony:${contestId}`]);
    const all = await guardiansOf(tx, contestId);
    const g = all.find((x) => x.admin_id === admin.id) ?? fail("not_a_guardian", "You are not a guardian of this contest", 403);
    if (!all.every((x) => x.backups)) return fail("wait", "All five guardians must post their backups first", 409);
    if (g.verified !== null) return fail("already_posted", "You already confirmed", 409);
    const others = all.filter((x) => x.admin_id !== admin.id).map((x) => x.admin_id).sort();
    const from = (input.verifications ?? []).map((v) => v.from).sort();
    if (JSON.stringify(from) !== JSON.stringify(others)) return fail("bad_verifications", "Confirm the backup from each of the four other guardians", 422);
    const ok = input.all_verified === true && input.verifications.every((v) => v.verified === true);
    await tx.query("UPDATE guardians SET verified=$3 WHERE contest_id=$1 AND admin_id=$2", [contestId, admin.id, ok]);
    if (!ok) return fail("verification_failed", "A backup did not verify. Stop: the ceremony must be redone with the secretary", 409);
    await ctx.events.emit(tx, { type: "guardian.verified", data: { contest_id: contestId, admin_id: admin.id } });
    if (all.filter((x) => x.admin_id !== admin.id).every((x) => x.verified === true)) joint = { keys: all.map((x) => x.public_key!) };
  });
  if (joint) {
    const keys = (joint as { keys: string[] }).keys;
    const { joint_public_key } = await eg.combineKeys(keys, GUARDIANS, QUORUM);
    await ctx.commit(async (tx) => {
      const ins = await tx.query("INSERT INTO election_keys(contest_id, n, quorum, joint_public_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1", [contestId, GUARDIANS, QUORUM, joint_public_key]);
      if (ins.length) await ctx.events.emit(tx, { type: "ceremony.completed", data: { contest_id: contestId, joint_key_hash: sha(joint_public_key) } });
    });
  }
  return { complete: !!joint };
}

// ---- Sealing the election ---------------------------------------------------------------------------------------------

/**
 * Fix the ballot description (offices and listed candidates) and build the election context from the joint key. After this nobody can add
 * an office or stand for one, because the ballot every voter encrypts against is now public and final. Runs as an approved action.
 */
export async function sealElection(ctx: Ctx, input: { contestId: string }) {
  const eg = egOf(ctx);
  const c = await contest(ctx.db, input.contestId);
  if (c.state !== "draft" && c.state !== "noticed") return fail("bad_state", "The election is sealed before voting opens", 409);
  const keys = await keysOf(ctx.db, c.id);
  if (!keys) return fail("no_keys", "The guardians have not finished the key ceremony", 409);
  if (keys.sealed_at) return fail("already_sealed", "Already sealed", 409);
  const races = await ctx.db.query<{ id: string; office: string; scope: string }>("SELECT id, office, scope FROM races WHERE contest_id=$1 ORDER BY created_at, id", [c.id]);
  const spec: { id: string; title: string; candidates: { id: string; name: string }[] }[] = [];
  for (const r of races) {
    const cands = await ctx.db.query<{ id: string; display_name: string }>("SELECT id, display_name FROM candidacies WHERE race_id=$1 AND state='listed' ORDER BY registered_at, id", [r.id]);
    if (cands.length) spec.push({ id: r.id, title: `${r.office} (${r.scope})`, candidates: cands.map((k) => ({ id: k.id, name: k.display_name })) });
  }
  if (!spec.length) return fail("empty_ballot", "There are no offices with a listed candidate to put on the ballot", 409);
  const vote = new Date(c.vote_date);
  const man = await eg.manifest({ id: c.id, name: c.name, start: vote.toISOString(), end: new Date(vote.getTime() + 86_400_000).toISOString(), contests: spec });
  const { context } = await eg.context(man.manifest, keys.joint_public_key, keys.n, keys.quorum);
  await ctx.commit(async (tx) => {
    const r = await tx.query("UPDATE election_keys SET manifest=$2, manifest_hash=$3, context=$4, sealed_at=$5 WHERE contest_id=$1 AND sealed_at IS NULL RETURNING 1",
      [c.id, man.manifest, man.manifest_hash, context, ctx.clock().toISOString()]);
    if (!r.length) return fail("already_sealed", "Already sealed", 409);
    await ctx.events.emit(tx, { type: "election.sealed", data: { contest_id: c.id, manifest_hash: sha(man.manifest), context_hash: sha(context), races: spec.length } });
  });
}

// ---- Casting ----------------------------------------------------------------------------------------------------------

/**
 * A member's ballot, encrypted. The choices are encrypted by the ElectionGuard service (the voter is on a phone or at a terminal that
 * cannot do it) and the plaintext is dropped at once. What is stored has no member id: a ciphertext, an anonymous nullifier (so a second
 * ballot from the same person replaces the first), the channel and the day. Who has voted is kept apart, with no link to any ballot.
 */
export async function castEncrypted(ctx: Ctx, p: {
  memberId: string; contestId: string; choices: Record<string, string | null>; channel: "ussd" | "agent" | "web"; unit?: string | null;
}): Promise<{ receipts: { raceId: string; receipt: string; revision: number }[] }> {
  const eg = egOf(ctx);
  const keys = (await keysOf(ctx.db, p.contestId)) ?? fail("not_found", "No election keys", 404);
  if (!keys.sealed_at || !keys.manifest || !keys.context) return fail("not_open", "The election is not sealed", 423);

  // Everything on the ballot must be answered, because a later ballot replaces the whole of the earlier one.
  const races = await ctx.db.query<{ id: string }>("SELECT DISTINCT r.id FROM races r JOIN candidacies k ON k.race_id=r.id AND k.state='listed' WHERE r.contest_id=$1", [p.contestId]);
  const want = new Set(races.map((r) => r.id));
  const got = Object.keys(p.choices);
  if (got.length !== want.size || !got.every((g) => want.has(g))) return fail("bad_choice", "Choose a candidate, or abstain, in every office", 422);
  for (const [raceId, cand] of Object.entries(p.choices)) {
    if (cand !== null && !(await ctx.db.query("SELECT 1 FROM candidacies WHERE id=$1 AND race_id=$2 AND state='listed'", [cand, raceId])).length)
      return fail("bad_choice", "That candidate is not on this ballot", 422);
  }
  // Fail early (before the slow encryption) when the member cannot vote.
  const pre = (await ctx.db.query<{ state: string; register_id: string | null }>("SELECT state, register_id FROM contests WHERE id=$1", [p.contestId]))[0];
  if (pre.state !== "open") return fail("not_open", pre.state === "closed" ? "Voting has closed" : "Voting is not open", 423);

  const ballotId = randomUUID();
  const enc = await eg.encrypt(keys.manifest, keys.context, ballotId, p.choices);
  const code = enc.ballot_code.toLowerCase().padStart(64, "0");
  const nullifier = ctx.keys.refHash(`nullifier:${p.contestId}`, p.memberId).slice(0, 32);
  const day = new Date(ctx.clock()); day.setUTCHours(0, 0, 0, 0);
  const unit = p.channel === "agent" && p.unit && UNIT.test(p.unit) ? p.unit : null;

  const revision = await ctx.commit(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vote:${p.memberId}:${p.contestId}`]);
    const c = (await tx.query<{ state: string; register_id: string | null }>("SELECT state, register_id FROM contests WHERE id=$1 FOR SHARE", [p.contestId]))[0];
    if (c.state !== "open") return fail("not_open", c.state === "closed" ? "Voting has closed" : "Voting is not open", 423);
    const ok = c.register_id && (await tx.query(
      "SELECT 1 FROM register_members rm JOIN members m ON m.id=rm.member_id WHERE rm.register_id=$1 AND rm.member_id=$2 AND m.state='active'", [c.register_id, p.memberId])).length;
    if (!ok) return fail("not_eligible", "You are not on this contest's register, or your membership is no longer active", 403);
    const v = (await tx.query<{ revisions: number }>("SELECT revisions FROM voted WHERE contest_id=$1 AND member_id=$2 FOR UPDATE", [p.contestId, p.memberId]))[0];
    const rev = (v?.revisions ?? 0) + 1;
    await tx.query("UPDATE enc_ballots SET superseded=TRUE WHERE contest_id=$1 AND nullifier=$2 AND NOT superseded", [p.contestId, nullifier]);
    await tx.query("INSERT INTO enc_ballots(id, contest_id, nullifier, ballot, ballot_code, channel, unit, cast_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [ballotId, p.contestId, nullifier, enc.ballot, code, p.channel, unit, day.toISOString()]);
    await tx.query(
      `INSERT INTO voted(contest_id, member_id, revisions, last_day) VALUES ($1,$2,$3,$4)
       ON CONFLICT (contest_id, member_id) DO UPDATE SET revisions=EXCLUDED.revisions, last_day=EXCLUDED.last_day`, [p.contestId, p.memberId, rev, day.toISOString()]);
    await ctx.events.emit(tx, { type: "ballot.submitted", data: { contest_id: p.contestId, ballot_id: ballotId, ballot_code: code, channel: p.channel, revision: rev } });
    return rev;
  });
  return { receipts: [{ raceId: "all", receipt: code, revision }] };
}

// ---- Tally ------------------------------------------------------------------------------------------------------------

export type TallySet = "all" | "agent";
const SETS: readonly string[] = ["all", "agent"];
const asSet = (s: string): TallySet => (SETS.includes(s) ? (s as TallySet) : fail("bad_set", "Unknown tally set", 422));

/**
 * Add up the encrypted ballots (the counted ones: each person's last). This is public maths on public ciphertexts; nothing is decrypted.
 * Set "agent" is the ballots cast at polling units, kept as a second total so it can be compared with the paper copies.
 */
export async function prepareTally(ctx: Ctx, contestId: string, set: TallySet = "all") {
  const eg = egOf(ctx);
  const c = await contest(ctx.db, contestId);
  if (c.state !== "closed") return fail("not_closed", "The tally is prepared after voting closes", 409);
  const keys = await keysOf(ctx.db, contestId);
  if (!keys?.sealed_at || !keys.manifest || !keys.context) return fail("not_sealed", "This contest has no sealed election", 409);
  const have = (await ctx.db.query<{ tally: string; ballots: number }>("SELECT tally, ballots FROM election_tallies WHERE contest_id=$1 AND tally_set=$2", [contestId, set]))[0];
  if (have) return { ballots: Number(have.ballots), prepared: false };

  const where = set === "agent" ? "AND channel='agent'" : "";
  const rows = await ctx.db.query<{ ballot: string }>(`SELECT ballot FROM enc_ballots WHERE contest_id=$1 AND NOT superseded ${where} ORDER BY ballot_code`, [contestId]);
  let tally: string | undefined; let count = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const r = await eg.tally(keys.manifest, keys.context, rows.slice(i, i + 100).map((x) => x.ballot), tally);
    tally = r.tally; count = r.count;
  }
  if (!tally) tally = (await eg.tally(keys.manifest, keys.context, [], undefined)).tally;
  await ctx.commit(async (tx) => {
    const ins = await tx.query("INSERT INTO election_tallies(contest_id, tally_set, tally, ballots, prepared_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1",
      [contestId, set, tally!, count, ctx.clock().toISOString()]);
    if (ins.length) await ctx.events.emit(tx, { type: "tally.prepared", data: { contest_id: contestId, tally_set: set, ballots: count, tally_hash: sha(tally!) } });
  });
  return { ballots: count, prepared: true };
}

/** A guardian's shares of the total, made on their own device. When a quorum has posted, the total is opened. */
export async function submitShares(ctx: Ctx, admin: Admin, contestId: string, setName: string, submission: Submission) {
  require_(admin, "guardian.act");
  const set = asSet(setName);
  if (!submission || submission.guardian_id !== admin.id) return fail("bad_submission", "These shares are not yours", 422);
  const g = await me(ctx.db, admin, contestId);
  void g;
  if (!(await ctx.db.query("SELECT 1 FROM election_tallies WHERE contest_id=$1 AND tally_set=$2", [contestId, set])).length) return fail("no_tally", "The tally has not been prepared yet", 409);
  await ctx.commit(async (tx) => {
    const ins = await tx.query("INSERT INTO guardian_shares(contest_id, tally_set, admin_id, payload, at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1",
      [contestId, set, admin.id, JSON.stringify(submission), ctx.clock().toISOString()]);
    if (!ins.length) return fail("already_posted", "You already posted your shares", 409);
    await ctx.events.emit(tx, { type: "tally.share_posted", data: { contest_id: contestId, tally_set: set, admin_id: admin.id } });
  });
  const n = Number((await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM guardian_shares WHERE contest_id=$1 AND tally_set=$2", [contestId, set]))[0].n);
  if (n >= QUORUM) await openTally(ctx, contestId, set);
  return { shares: n, quorum: QUORUM, opened: n >= QUORUM };
}

/** Combine a quorum's shares into the TOTAL (never a single ballot) and publish the counts. Idempotent. */
export async function openTally(ctx: Ctx, contestId: string, set: TallySet) {
  const eg = egOf(ctx);
  const keys = (await keysOf(ctx.db, contestId)) ?? fail("not_found", "No election keys", 404);
  const t = (await ctx.db.query<{ tally: string; ballots: number; opened_at: string | null }>("SELECT tally, ballots, opened_at FROM election_tallies WHERE contest_id=$1 AND tally_set=$2", [contestId, set]))[0];
  if (!t) return fail("no_tally", "The tally has not been prepared yet", 409);
  if (t.opened_at) return;
  const subs = (await ctx.db.query<{ payload: string }>("SELECT payload FROM guardian_shares WHERE contest_id=$1 AND tally_set=$2 ORDER BY at", [contestId, set])).map((r) => JSON.parse(r.payload) as Submission);
  if (subs.length < keys.quorum) return fail("need_quorum", `Need ${keys.quorum} guardians; ${subs.length} so far`, 409);
  const pubs = (await guardiansOf(ctx.db, contestId)).map((g) => g.public_key!);
  const out = await eg.decrypt(keys.manifest!, keys.context!, t.tally, pubs, subs);
  await ctx.commit(async (tx) => {
    const up = await tx.query("UPDATE election_tallies SET counts=$3, plaintext_tally=$4, opened_at=$5, guardians_present=$6 WHERE contest_id=$1 AND tally_set=$2 AND opened_at IS NULL RETURNING 1",
      [contestId, set, JSON.stringify(out.counts), out.plaintext_tally, ctx.clock().toISOString(), JSON.stringify(out.guardians_present)]);
    if (!up.length) return;
    await ctx.events.emit(tx, { type: "tally.opened", data: { contest_id: contestId, tally_set: set, present: out.guardians_present.length, absent: out.guardians_absent.length } });
    if (set === "all") {
      const eligible = await eligibleCount(tx, contestId);
      for (const [raceId, byCand] of Object.entries(out.counts)) {
        const votes = Object.values(byCand).reduce((s, n) => s + n, 0);
        await ctx.events.emit(tx, { type: "race.turnout", data: { contest_id: contestId, race_id: raceId, ballots: Number(t.ballots), abstained: Number(t.ballots) - votes, eligible } });
        for (const [candId, n] of Object.entries(byCand)) await ctx.events.emit(tx, { type: "race.result", data: { contest_id: contestId, race_id: raceId, candidacy_id: candId, votes: n } });
      }
    }
  });
}

async function eligibleCount(db: Db, contestId: string): Promise<number> {
  const r = await db.query<{ member_count: number }>("SELECT r.member_count FROM contests c JOIN registers r ON r.id=c.register_id WHERE c.id=$1", [contestId]);
  return Number(r[0]?.member_count ?? 0);
}

/** Results for a sealed contest, in the same shape as the plain tally. 423 until a quorum of guardians has opened the total. */
export async function encryptedResults(ctx: Ctx, contestId: string) {
  const t = (await ctx.db.query<{ counts: string | null; ballots: number; opened_at: string | null }>("SELECT counts, ballots, opened_at FROM election_tallies WHERE contest_id=$1 AND tally_set='all'", [contestId]))[0];
  if (!t || !t.opened_at || !t.counts) {
    const shares = Number((await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM guardian_shares WHERE contest_id=$1 AND tally_set='all'", [contestId]))[0].n);
    return fail("results_not_ready", t ? `Waiting for the guardians: ${shares} of ${QUORUM} needed have opened the total` : "The tally has not been prepared yet", 423);
  }
  const counts = JSON.parse(t.counts) as Record<string, Record<string, number>>;
  const eligible = await eligibleCount(ctx.db, contestId);
  const races = await ctx.db.query<{ id: string; office: string; scope: string }>("SELECT id, office, scope FROM races WHERE contest_id=$1 ORDER BY created_at, id", [contestId]);
  const names = new Map((await ctx.db.query<{ id: string; display_name: string }>("SELECT id, display_name FROM candidacies WHERE contest_id=$1", [contestId])).map((k) => [k.id, k.display_name]));
  const out = [];
  for (const r of races) {
    const byCand = counts[r.id];
    if (!byCand) continue;
    const candidates = Object.entries(byCand).map(([candacyId, votes]) => ({ candidacyId: candacyId, name: names.get(candacyId) ?? "", votes }));
    const top = Math.max(0, ...candidates.map((c) => c.votes));
    const leaders = top > 0 ? candidates.filter((c) => c.votes === top) : [];
    const ballots = Number(t.ballots);
    out.push({ raceId: r.id, office: r.office, scope: r.scope, ballots, abstained: ballots - candidates.reduce((s, c) => s + c.votes, 0), eligible, candidates,
      winnerId: leaders.length === 1 ? leaders[0].candidacyId : null, tie: leaders.length > 1 });
  }
  return { races: out };
}

// ---- Paper audit ------------------------------------------------------------------------------------------------------

/**
 * Polling units keep a paper copy of every ballot cast on their terminal. After voting closes, the ward agent counts that paper and
 * submits the totals once. They are compared with the electronic count for the same unit (see paperAudit). The paper never leaves the
 * unit; only the counts do.
 */
export async function submitPaperCount(ctx: Ctx, agent: Admin, input: { contestId: string; unit: string; ballots: number; counts: { raceId: string; candidacyId: string | null; n: number }[] }) {
  if (agent.role !== "ward_agent") return fail("forbidden", "Only ward agents report paper counts", 403);
  const c = await contest(ctx.db, input.contestId);
  if (c.state !== "closed") return fail("not_closed", "Paper counts are reported after voting closes", 409);
  if (!UNIT.test(String(input.unit ?? ""))) return fail("bad_unit", "Polling unit: 1 to 40 letters, digits and . _ ' -", 422);
  if (!Number.isSafeInteger(input.ballots) || input.ballots < 0) return fail("bad_count", "The number of paper ballots must be a whole number", 422);
  const perRace = new Map<string, number>();
  for (const k of input.counts ?? []) {
    if (!Number.isSafeInteger(k.n) || k.n < 0) return fail("bad_count", "Counts must be whole numbers", 422);
    perRace.set(k.raceId, (perRace.get(k.raceId) ?? 0) + k.n);
  }
  for (const [raceId, sum] of perRace) if (sum > input.ballots) return fail("bad_count", "More votes than paper ballots in one office", 422);
  await ctx.commit(async (tx) => {
    for (const k of input.counts ?? []) {
      const ok = await tx.query("SELECT 1 FROM races r WHERE r.id=$1 AND r.contest_id=$2 AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM candidacies WHERE id=$3 AND race_id=r.id AND state='listed'))", [k.raceId, c.id, k.candidacyId]);
      if (!ok.length) return fail("bad_choice", "A count names an office or candidate that is not on the ballot", 422);
    }
    const ins = await tx.query("INSERT INTO paper_totals(contest_id, unit, ballots, agent_id, at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1",
      [c.id, input.unit, input.ballots, agent.id, ctx.clock().toISOString()]);
    if (!ins.length) return fail("paper_already", "This unit's paper count was already reported and cannot be changed", 409);
    for (const k of input.counts ?? [])
      await tx.query("INSERT INTO paper_counts(contest_id, unit, race_id, candidacy_id, n) VALUES ($1,$2,$3,$4,$5)", [c.id, input.unit, k.raceId, k.candidacyId ?? "abstain", k.n]);
    await ctx.events.emit(tx, { type: "paper.counted", data: { contest_id: c.id, unit: input.unit, ballots: input.ballots } });
  });
}

/**
 * Compare the paper with the electronic record. Per unit: paper ballots vs electronic ballots cast at that unit (public numbers, no choices).
 * Once the polling-unit total has been opened by the guardians too: per office and candidate, the sum of all paper counts vs the
 * electronic polling-unit total. Any difference is reported, never hidden.
 */
export async function paperAudit(ctx: Ctx, contestId: string) {
  const c = await contest(ctx.db, contestId);
  if (c.state !== "closed") return fail("not_closed", "The audit is available after voting closes", 409);
  const elec = await ctx.db.query<{ unit: string; n: number }>("SELECT unit, COUNT(*)::int AS n FROM enc_ballots WHERE contest_id=$1 AND channel='agent' AND NOT superseded AND unit IS NOT NULL GROUP BY unit", [contestId]);
  const paper = await ctx.db.query<{ unit: string; ballots: number }>("SELECT unit, ballots FROM paper_totals WHERE contest_id=$1", [contestId]);
  const units = new Map<string, { unit: string; paperBallots: number | null; electronicBallots: number }>();
  for (const e of elec) units.set(e.unit, { unit: e.unit, paperBallots: null, electronicBallots: Number(e.n) });
  for (const p of paper) units.set(p.unit, { unit: p.unit, paperBallots: Number(p.ballots), electronicBallots: units.get(p.unit)?.electronicBallots ?? 0 });
  const perUnit = [...units.values()].sort((a, b) => a.unit.localeCompare(b.unit)).map((u) => ({
    ...u, status: u.paperBallots === null ? "paper_missing" : u.paperBallots === u.electronicBallots ? "match" : "mismatch" }));

  let choices: null | { raceId: string; candidacyId: string; paper: number; electronic: number; match: boolean }[] = null;
  const agentTally = (await ctx.db.query<{ counts: string | null }>("SELECT counts FROM election_tallies WHERE contest_id=$1 AND tally_set='agent' AND opened_at IS NOT NULL", [contestId]))[0];
  if (agentTally?.counts) {
    const counts = JSON.parse(agentTally.counts) as Record<string, Record<string, number>>;
    const sums = await ctx.db.query<{ race_id: string; candidacy_id: string; n: number }>("SELECT race_id, candidacy_id, SUM(n)::int AS n FROM paper_counts WHERE contest_id=$1 GROUP BY race_id, candidacy_id", [contestId]);
    choices = [];
    for (const [raceId, byCand] of Object.entries(counts))
      for (const [candId, e] of Object.entries(byCand)) {
        const p = Number(sums.find((s) => s.race_id === raceId && s.candidacy_id === candId)?.n ?? 0);
        choices.push({ raceId, candidacyId: candId, paper: p, electronic: e, match: p === e });
      }
  }
  const discrepancies = perUnit.filter((u) => u.status !== "match").length + (choices?.filter((x) => !x.match).length ?? 0);
  return { contestId, units: perUnit, choices, discrepancies, complete: perUnit.length > 0 && perUnit.every((u) => u.status === "match") && !!choices };
}

// ---- The public record ------------------------------------------------------------------------------------------------

/** Everything a stranger needs to check the election except the ballots themselves (those are paged below). */
export async function publicRecord(ctx: Ctx, contestId: string) {
  const keys = await keysOf(ctx.db, contestId);
  const gs = await guardiansOf(ctx.db, contestId);
  const tallies = await ctx.db.query<{ tally_set: string; ballots: number; tally: string; counts: string | null; plaintext_tally: string | null; opened_at: string | null; guardians_present: string | null }>(
    "SELECT tally_set, ballots, tally, counts, plaintext_tally, opened_at, guardians_present FROM election_tallies WHERE contest_id=$1", [contestId]);
  const shareCounts = await ctx.db.query<{ tally_set: string; n: number }>("SELECT tally_set, COUNT(*)::int AS n FROM guardian_shares WHERE contest_id=$1 GROUP BY tally_set", [contestId]);
  const total = (await ctx.db.query<{ n: number; sup: number }>("SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE superseded)::int AS sup FROM enc_ballots WHERE contest_id=$1", [contestId]))[0];
  return {
    contestId, secretBallot: !!keys, sealed: !!keys?.sealed_at,
    guardians: gs.map((g) => ({ position: g.position, adminId: g.admin_id, keyPosted: !!g.public_key, verified: g.verified })),
    n: keys?.n ?? GUARDIANS, quorum: keys?.quorum ?? QUORUM,
    publicKeys: gs.every((g) => g.public_key) ? gs.map((g) => g.public_key) : [],
    jointPublicKey: keys?.joint_public_key ?? null, manifest: keys?.manifest ?? null, manifestHash: keys?.manifest_hash ?? null, context: keys?.context ?? null,
    ballots: { submitted: Number(total.n), superseded: Number(total.sup), counted: Number(total.n) - Number(total.sup) },
    tallies: tallies.map((t) => ({ set: t.tally_set, ballots: Number(t.ballots), shares: Number(shareCounts.find((c) => c.tally_set === t.tally_set)?.n ?? 0), tally: t.tally, opened: !!t.opened_at, counts: t.counts ? JSON.parse(t.counts) : null, plaintextTally: t.plaintext_tally, guardiansPresent: t.guardians_present ? JSON.parse(t.guardians_present) : null })),
  };
}

/** Page through the encrypted ballots in ballot-code order (not arrival order, so position says nothing about timing). */
export async function publicBallots(ctx: Ctx, contestId: string, after: string | undefined, limit = 100) {
  const lim = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
  const rows = await ctx.db.query<{ id: string; ballot_code: string; channel: string; unit: string | null; cast_day: string; superseded: boolean; ballot: string }>(
    "SELECT id, ballot_code, channel, unit, cast_day, superseded, ballot FROM enc_ballots WHERE contest_id=$1 AND ($2::text IS NULL OR ballot_code > $2) ORDER BY ballot_code LIMIT $3", [contestId, after ?? null, lim]);
  return { ballots: rows.map((r) => ({ id: r.id, ballotCode: r.ballot_code, channel: r.channel, unit: r.unit, castDay: new Date(r.cast_day).toISOString().slice(0, 10), superseded: r.superseded, ballot: r.ballot })), next: rows.length === lim ? rows[rows.length - 1].ballot_code : null };
}

/** Run the service's independent re-check over everything published (every ballot's proofs, and that the tally is exactly their sum). */
export async function verifyRecord(ctx: Ctx, contestId: string) {
  const eg = egOf(ctx);
  const keys = await keysOf(ctx.db, contestId);
  const t = (await ctx.db.query<{ tally: string }>("SELECT tally FROM election_tallies WHERE contest_id=$1 AND tally_set='all'", [contestId]))[0];
  if (!keys?.manifest || !keys.context || !t) return fail("nothing_to_verify", "There is no prepared tally to verify yet", 409);
  const rows = await ctx.db.query<{ ballot: string }>("SELECT ballot FROM enc_ballots WHERE contest_id=$1 AND NOT superseded ORDER BY ballot_code", [contestId]);
  return eg.verify(keys.manifest, keys.context, rows.map((r) => r.ballot), t.tally);
}
