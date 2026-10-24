import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import type { Db } from "./db.js";
import { logRef } from "./context.js";
import { fail } from "./errors.js";
import { require_, type Admin } from "./admin.js";
import { collectFormFee } from "./finance.js";
import { verifyPin } from "./members.js";
import { t } from "./i18n.js";
import { castEncrypted, encryptedResults, isSealed } from "./secret-ballot.js";
import { modeOf, registerDeviceCommitment, resetToAssisted } from "./semaphore.js";

/**
 * Phase 1 of voting: the ballot box. Races, candidates (public by design), vetting stamps, form fees, ballots and the tally.
 *
 * WHAT THIS IS NOT YET: a secret ballot. A ballot row stores the voter next to the choice, so anyone with database access can see
 * who voted for whom. The public log carries only counts and anonymous receipts. Phases 2 and 3 (anonymous proofs, encrypted
 * tally) remove that link; until then this must not be used for a real contest. See docs/voting.md.
 */

const TITLE = /^[A-Za-z0-9][A-Za-z0-9 ._'(),&/-]{0,79}$/;
const PERSON = /^\p{L}[\p{L}\p{M} .'-]{1,79}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ContestRow { id: string; state: string; register_id: string | null; vote_date: string; name: string }
async function contestRow(db: Db, id: string): Promise<ContestRow> {
  const r = await db.query<ContestRow>("SELECT id, state, register_id, vote_date, name FROM contests WHERE id=$1", [id]);
  return r.length ? r[0] : fail("not_found", "No such contest", 404);
}
const beforeVoting = (c: ContestRow) => c.state === "draft" || c.state === "noticed";
/** Offices and candidates can change only before voting AND before the ballot is sealed (once the guardians' keys are in, the ballot is public and final). */
const candidacyOpen = async (db: Db, c: ContestRow) => beforeVoting(c) && !(await isSealed(db, c.id));

// ---- Races ------------------------------------------------------------------------------------

/** Add an office to a contest's ballot. Only the secretary or the electoral committee, and only before voting opens. */
export async function createRace(ctx: Ctx, admin: Admin, input: { contestId: string; office: string; scope?: string; formFeeMinor?: number }) {
  require_(admin, "race.manage");
  const c = await contestRow(ctx.db, input.contestId);
  if (!(await candidacyOpen(ctx.db, c))) return fail("candidacy_closed", "Races cannot change once the election is sealed or voting has opened", 409);
  const office = String(input.office ?? "").trim();
  const scope = String(input.scope ?? "").trim() || "All";
  if (!TITLE.test(office)) return fail("bad_office", "Office: 1 to 80 characters, letters, digits and ( ) , & . ' - /");
  if (!TITLE.test(scope)) return fail("bad_scope", "Scope: 1 to 80 characters, letters, digits and ( ) , & . ' - /");
  const fee = input.formFeeMinor ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0) return fail("bad_fee", "The form fee must be a whole number of minor units, zero or more");
  // No cap on form fees: the owner decided that parties may charge what they choose. (Candidates see the fee before they pay it, and it is public.)
  const id = randomUUID();
  try {
    await ctx.commit(async (tx) => {
      await tx.query("INSERT INTO races(id,contest_id,office,scope,form_fee_minor,created_by) VALUES ($1,$2,$3,$4,$5,$6)", [id, c.id, office, scope, fee, admin.id]);
      await ctx.events.emit(tx, { type: "race.created", data: { contest_id: c.id, race_id: id, office, scope, form_fee_minor: fee } });
    });
  } catch (e: any) {
    if (/unique|duplicate/i.test(String(e?.message))) return fail("race_exists", "That office and scope are already on this contest", 409);
    throw e;
  }
  return { raceId: id };
}

// ---- Candidates -------------------------------------------------------------------------------

/**
 * Anyone who is an active member can register to compete: the party sets no other test, and admins cannot refuse them (they can only
 * stamp, below). Candidates are public: the name is published and permanent on the log, so consent is explicit and the member's
 * visibility is set to "visible". If the race has a form fee, the candidate is listed on the ballot once it is paid.
 */
export async function registerCandidate(ctx: Ctx, input: { phone: string; pin: string; raceId: string; consentPublic: boolean }) {
  if (input.consentPublic !== true)
    return fail("consent_required", "Candidates are public. Your name and your candidacy are published on the public log and cannot be hidden or removed later. Confirm to continue.", 422);
  const m = await verifyPin(ctx, input.phone, input.pin);
  const race = (await ctx.db.query<{ id: string; contest_id: string; form_fee_minor: number; office: string }>(
    "SELECT id, contest_id, form_fee_minor::float8 AS form_fee_minor, office FROM races WHERE id=$1", [input.raceId]))[0];
  if (!race) return fail("not_found", "No such race", 404);
  const c = await contestRow(ctx.db, race.contest_id);
  if (!(await candidacyOpen(ctx.db, c))) return fail("candidacy_closed", "Candidacy closed when the election was sealed or voting opened", 409);
  const row = (await ctx.db.query<{ state: string; record_enc: string }>("SELECT state, record_enc FROM members WHERE id=$1", [m.id]))[0];
  if (row.state !== "active") return fail("not_active", "Only active members can stand. See your ward agent to be activated.", 403);
  const rec = await ctx.keys.decrypt<Record<string, string>>(m.id, row.record_enc);
  const name = String(rec.name ?? "").trim();
  if (!PERSON.test(name)) return fail("name_not_publishable", "The name on your record cannot be published (letters, spaces, . ' - only). See your ward agent.", 422);

  const fee = Number(race.form_fee_minor);
  const prior = (await ctx.db.query<{ id: string; state: string; fee_ledger_id: number | null }>("SELECT id, state, fee_ledger_id FROM candidacies WHERE race_id=$1 AND member_id=$2", [race.id, m.id]))[0];
  if (prior && prior.state !== "withdrawn") return fail("already_candidate", "You are already a candidate in this race", 409);
  const state = fee > 0 && !(prior && prior.fee_ledger_id) ? "pending_payment" : "listed";
  const id = prior?.id ?? randomUUID();
  await ctx.commit(async (tx) => {
    if (prior) await tx.query("UPDATE candidacies SET state=$2, listed_at=$3 WHERE id=$1", [id, state, state === "listed" ? ctx.clock().toISOString() : null]);
    else await tx.query(
      "INSERT INTO candidacies(id,race_id,contest_id,member_id,display_name,fee_minor,state,registered_at,listed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, race.id, race.contest_id, m.id, name, fee, state, ctx.clock().toISOString(), state === "listed" ? ctx.clock().toISOString() : null]);
    await tx.query("UPDATE members SET visibility='visible' WHERE id=$1", [m.id]);
    await ctx.events.emit(tx, { type: "candidate.registered", data: { contest_id: race.contest_id, race_id: race.id, candidacy_id: id, member_ref: logRef(ctx, "member", m.id), candidate: name, fee_minor: fee } });
    if (state === "listed") await ctx.events.emit(tx, { type: "candidate.listed", data: { contest_id: race.contest_id, race_id: race.id, candidacy_id: id } });
  });
  const cur = ctx.config.pack.currency;
  if (rec.phone) await ctx.sms.send(rec.phone, state === "listed" ? t(ctx, "sms.candidateListed", race.office) : t(ctx, "sms.candidateFee", race.office, cur.symbol, fee / cur.minor_per_unit)).catch(() => {});
  return { candidacyId: id, state, feeMinor: fee };
}

/** Buy the candidate form. Safe to repeat: the fee is charged once and the candidacy is listed in the same transaction that records it. */
export async function payForm(ctx: Ctx, input: { phone: string; pin: string; candidacyId: string }) {
  const m = await verifyPin(ctx, input.phone, input.pin);
  const r = await collectFormFee(ctx, m.id, input.phone, input.candidacyId);
  return { ledgerId: r.ledgerId, duplicate: r.duplicate };
}

/** Step down before voting opens. A paid form fee is not refunded by this code (the party decides that, off the ledger). */
export async function withdrawCandidate(ctx: Ctx, input: { phone: string; pin: string; candidacyId: string }) {
  const m = await verifyPin(ctx, input.phone, input.pin);
  await ctx.commit(async (tx) => {
    const k = (await tx.query<{ race_id: string; contest_id: string; member_id: string; state: string; cstate: string }>(
      "SELECT k.race_id, k.contest_id, k.member_id, k.state, c.state AS cstate FROM candidacies k JOIN contests c ON c.id=k.contest_id WHERE k.id=$1 FOR UPDATE OF k", [input.candidacyId]))[0];
    if (!k || k.member_id !== m.id) return fail("not_found", "No such candidacy", 404);
    if (k.state === "withdrawn") return fail("bad_state", "Already withdrawn", 409);
    if (k.cstate !== "draft" && k.cstate !== "noticed") return fail("candidacy_closed", "Candidates cannot withdraw once voting has opened", 409);
    if (await isSealed(tx, k.contest_id)) return fail("candidacy_closed", "Candidates cannot withdraw once the election is sealed", 409);
    await tx.query("UPDATE candidacies SET state='withdrawn' WHERE id=$1", [input.candidacyId]);
    await ctx.events.emit(tx, { type: "candidate.withdrawn", data: { contest_id: k.contest_id, race_id: k.race_id, candidacy_id: input.candidacyId } });
  });
}

/**
 * A member registers the PUBLIC commitment of an identity they made on their own device (the secret never leaves it). From then on they
 * vote from that device, anonymously: no login at all, and nothing the platform holds can say which ballot is theirs. Do this before the
 * election is sealed; the group of voters is fixed at sealing.
 */
export async function registerIdentity(ctx: Ctx, input: { phone: string; pin: string; commitment: string }) {
  const m = await verifyPin(ctx, input.phone, input.pin);
  await registerDeviceCommitment(ctx, m.id, input.commitment);
  return { mode: "device" as const };
}

/** A ward agent, with the member present, returns them to the platform-derived identity (a lost or broken device). Before the group is built. */
export async function resetIdentity(ctx: Ctx, agent: Admin, input: { memberId: string }) {
  if (agent.role !== "ward_agent") return fail("forbidden", "Only ward agents can reset an identity", 403);
  const row = (await ctx.db.query<{ ward: string | null }>("SELECT ward FROM members WHERE id=$1", [input.memberId]))[0];
  if (!row) return fail("not_found", "No such member", 404);
  if (row.ward && row.ward !== agent.ward) return fail("wrong_ward", "Agent can only reset members of their own ward", 403);
  await resetToAssisted(ctx, input.memberId);
}

/** The member's own candidacies, with what is still owed. */
export async function myCandidacies(ctx: Ctx, input: { phone: string; pin: string }) {
  const m = await verifyPin(ctx, input.phone, input.pin);
  return ctx.db.query(
    `SELECT k.id, k.state, k.fee_minor::float8 AS fee_minor, r.office, r.scope, c.name AS contest, c.state AS contest_state
     FROM candidacies k JOIN races r ON r.id=k.race_id JOIN contests c ON c.id=k.contest_id WHERE k.member_id=$1 ORDER BY k.registered_at`, [m.id]);
}

/**
 * A vetting stamp. Every admin may give one; it is information for voters and nothing more: a flagged candidate stays on the ballot
 * because "everyone who registers to compete can be a candidate". One stamp per admin per candidate, which that admin may change.
 */
export async function stampCandidate(ctx: Ctx, admin: Admin, candidacyId: string, verdict: string, note?: string) {
  require_(admin, "candidate.stamp");
  if (verdict !== "vetted" && verdict !== "flagged") return fail("bad_verdict", "A stamp is either vetted or flagged");
  const n = (note ?? "").trim();
  if (n.length > 280) return fail("note_too_long", "Keep the note under 280 characters");
  await ctx.commit(async (tx) => {
    const k = (await tx.query<{ state: string; cstate: string }>(
      "SELECT k.state, c.state AS cstate FROM candidacies k JOIN contests c ON c.id=k.contest_id WHERE k.id=$1", [candidacyId]))[0];
    if (!k) return fail("not_found", "No such candidate", 404);
    if (k.state === "withdrawn") return fail("bad_state", "That candidate has withdrawn", 409);
    if (k.cstate === "closed") return fail("contest_closed", "The contest is closed", 409);
    await tx.query(
      `INSERT INTO candidate_stamps(candidacy_id, admin_id, verdict, note, at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (candidacy_id, admin_id) DO UPDATE SET verdict=EXCLUDED.verdict, note=EXCLUDED.note, at=EXCLUDED.at`,
      [candidacyId, admin.id, verdict, n || null, ctx.clock().toISOString()]);
    await ctx.events.emit(tx, { type: "candidate.stamped", data: { candidacy_id: candidacyId, admin_id: admin.id, verdict } });
  });
}

export type StampStatus = "vetted" | "flagged" | "mixed" | "unvetted";
const statusOf = (vetted: number, flagged: number): StampStatus => (vetted && flagged ? "mixed" : vetted ? "vetted" : flagged ? "flagged" : "unvetted");

/** The public view of a contest's ballot: races, listed candidates and their stamps. `admin` adds unpaid candidates and stamp notes. */
export async function listElection(ctx: Ctx, contestId: string, opts: { admin?: boolean } = {}) {
  const c = await contestRow(ctx.db, contestId);
  const races = await ctx.db.query<{ id: string; office: string; scope: string; form_fee_minor: number }>(
    "SELECT id, office, scope, form_fee_minor::float8 AS form_fee_minor FROM races WHERE contest_id=$1 ORDER BY created_at, id", [contestId]);
  const out = [];
  for (const r of races) {
    const ks = await ctx.db.query<{ id: string; display_name: string; state: string; vetted: number; flagged: number }>(
      `SELECT k.id, k.display_name, k.state,
              (SELECT COUNT(*)::int FROM candidate_stamps s WHERE s.candidacy_id=k.id AND s.verdict='vetted') AS vetted,
              (SELECT COUNT(*)::int FROM candidate_stamps s WHERE s.candidacy_id=k.id AND s.verdict='flagged') AS flagged
       FROM candidacies k WHERE k.race_id=$1 AND k.state <> 'withdrawn' ${opts.admin ? "" : "AND k.state='listed'"} ORDER BY k.registered_at, k.id`, [r.id]);
    const candidates = [];
    for (const k of ks) {
      const stamps = opts.admin
        ? await ctx.db.query<{ admin_id: string; verdict: string; note: string | null }>("SELECT admin_id, verdict, note FROM candidate_stamps WHERE candidacy_id=$1 ORDER BY at", [k.id])
        : undefined;
      candidates.push({ id: k.id, name: k.display_name, state: k.state, vetted: k.vetted, flagged: k.flagged, status: statusOf(k.vetted, k.flagged), ...(stamps ? { stamps } : {}) });
    }
    out.push({ id: r.id, office: r.office, scope: r.scope, formFeeMinor: Number(r.form_fee_minor), candidates });
  }
  const keys = await ctx.db.query<{ sealed_at: string | null }>("SELECT sealed_at FROM election_keys WHERE contest_id=$1", [contestId]);
  return { contestId: c.id, name: c.name, state: c.state, voteDate: c.vote_date, secretBallot: !!keys.length, sealed: !!keys[0]?.sealed_at, races: out };
}

// ---- Voting -----------------------------------------------------------------------------------

/** What this member would see on the ballot: races that have candidates, the current choice in each, and whether they may vote. */
export async function ballotView(ctx: Ctx, memberId: string, contestId: string) {
  const c = await contestRow(ctx.db, contestId);
  const { isEligible } = await import("./contests.js");
  const eligible = await isEligible(ctx, contestId, memberId);
  const view = await listElection(ctx, contestId);
  const secret = await isSealed(ctx.db, contestId);
  // In a secret ballot the platform does not know, and cannot show, what a member chose before: only THAT they voted.
  const mine = secret ? [] : await ctx.db.query<{ race_id: string; candidacy_id: string | null; revision: number; receipt: string }>(
    "SELECT race_id, candidacy_id, revision, receipt FROM ballots WHERE contest_id=$1 AND member_id=$2", [contestId, memberId]);
  const voted = secret ? (await ctx.db.query<{ revisions: number }>("SELECT revisions FROM voted WHERE contest_id=$1 AND member_id=$2", [contestId, memberId]))[0] : undefined;
  const races = view.races.filter((r) => r.candidates.length > 0).map((r) => {
    const b = mine.find((x) => x.race_id === r.id);
    return { id: r.id, office: r.office, scope: r.scope, candidates: r.candidates.map(({ id, name, status }) => ({ id, name, status })),
      current: b ? { candidacyId: b.candidacy_id, revision: b.revision, receipt: b.receipt } : null };
  });
  const identity = secret ? await modeOf(ctx.db, memberId) : null;
  return { contestId, name: c.name, state: c.state, open: c.state === "open", eligible, secret, identity, voted: voted ? { revisions: Number(voted.revisions) } : null, races };
}

export type Channel = "ussd" | "agent" | "web";

/**
 * Record or replace a member's ballot. Voting is allowed only while the contest is open and only for members on the frozen register
 * who are still active. Casting again replaces the earlier choice (last ballot counts). `null` is an explicit abstention. Races not
 * named in `choices` are left as they were.
 */
export async function castBallot(ctx: Ctx, p: { memberId: string; contestId: string; choices: Record<string, string | null>; channel: Channel; agentId?: string; notifyPhone?: string; unit?: string | null }) {
  if (await isSealed(ctx.db, p.contestId)) {
    const r = await castEncrypted(ctx, { memberId: p.memberId, contestId: p.contestId, choices: p.choices, channel: p.channel, unit: p.unit });
    if (p.notifyPhone) await ctx.sms.send(p.notifyPhone, t(ctx, "sms.voteCounted", r.receipts[0].receipt.slice(0, 8).toUpperCase())).catch(() => {});
    return r;
  }
  const entries = Object.entries(p.choices ?? {});
  if (!entries.length) return fail("nothing_to_do", "No choices given");
  for (const [raceId, cand] of entries) {
    if (!UUID.test(raceId) || !(cand === null || (typeof cand === "string" && UUID.test(cand)))) return fail("bad_choice", "Each choice is a race id and a candidate id (or null to abstain)");
  }
  const receipts = await ctx.commit(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vote:${p.memberId}:${p.contestId}`]);
    // FOR SHARE: closing the contest needs the exclusive lock, so a ballot cannot slip in after the close has started.
    const c = (await tx.query<{ state: string; register_id: string | null }>("SELECT state, register_id FROM contests WHERE id=$1 FOR SHARE", [p.contestId]))[0];
    if (!c) return fail("not_found", "No such contest", 404);
    if (c.state !== "open") return fail("not_open", c.state === "closed" ? "Voting has closed" : "Voting is not open", 423);
    const ok = c.register_id && (await tx.query(
      "SELECT 1 FROM register_members rm JOIN members m ON m.id=rm.member_id WHERE rm.register_id=$1 AND rm.member_id=$2 AND m.state='active'", [c.register_id, p.memberId])).length;
    if (!ok) return fail("not_eligible", "You are not on this contest's register, or your membership is no longer active", 403);

    const out: { raceId: string; receipt: string; revision: number }[] = [];
    for (const [raceId, cand] of entries) {
      const race = await tx.query("SELECT 1 FROM races WHERE id=$1 AND contest_id=$2", [raceId, p.contestId]);
      if (!race.length) return fail("bad_choice", "That race is not on this ballot", 422);
      if (cand !== null && !(await tx.query("SELECT 1 FROM candidacies WHERE id=$1 AND race_id=$2 AND state='listed'", [cand, raceId])).length)
        return fail("bad_choice", "That candidate is not on this ballot", 422);
      const prior = (await tx.query<{ revision: number; receipt: string }>("SELECT revision, receipt FROM ballots WHERE contest_id=$1 AND race_id=$2 AND member_id=$3 FOR UPDATE", [p.contestId, raceId, p.memberId]))[0];
      const now = ctx.clock().toISOString();
      let receipt: string, revision: number;
      if (prior) {
        receipt = prior.receipt; revision = prior.revision + 1;
        await tx.query("UPDATE ballots SET candidacy_id=$4, revision=$5, channel=$6, agent_id=$7, cast_at=$8 WHERE contest_id=$1 AND race_id=$2 AND member_id=$3",
          [p.contestId, raceId, p.memberId, cand, revision, p.channel, p.agentId ?? null, now]);
      } else {
        receipt = randomUUID(); revision = 1;
        await tx.query("INSERT INTO ballots(contest_id,race_id,member_id,candidacy_id,revision,channel,agent_id,receipt,cast_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [p.contestId, raceId, p.memberId, cand, revision, p.channel, p.agentId ?? null, receipt, now]);
      }
      // The log learns that a ballot was cast or replaced, by which channel, under an anonymous receipt. Never who, never for whom.
      await ctx.events.emit(tx, { type: "ballot.cast", data: { contest_id: p.contestId, race_id: raceId, ballot_ref: receipt, channel: p.channel, revision } });
      out.push({ raceId, receipt, revision });
    }
    return out;
  });
  if (p.notifyPhone) await ctx.sms.send(p.notifyPhone, t(ctx, "sms.voteCounted", receipts[0].receipt.slice(0, 8).toUpperCase())).catch(() => {});
  return { receipts };
}

/**
 * The contest a voter should be sent to. If several are open, the one this member can vote in comes first (they are on its register
 * and still active), then the earliest vote date. Without a member, simply the earliest open contest.
 */
export async function currentOpenContest(ctx: Ctx, memberId?: string): Promise<string | null> {
  const r = await ctx.db.query<{ id: string }>(
    `SELECT c.id FROM contests c WHERE c.state='open'
     ORDER BY (CASE WHEN $1::text IS NOT NULL AND EXISTS (
         SELECT 1 FROM register_members rm JOIN members m ON m.id=rm.member_id
         WHERE rm.register_id=c.register_id AND rm.member_id=$1 AND m.state='active') THEN 0 ELSE 1 END), c.vote_date LIMIT 1`, [memberId ?? null]);
  return r.length ? r[0].id : null;
}

// ---- Web and agent entry points: both identify the member by phone and PIN, which are throttled per member in verifyPin -----

export async function webBallot(ctx: Ctx, input: { phone: string; pin: string; contestId?: string }) {
  const m = await verifyPin(ctx, input.phone, input.pin);
  const contestId = input.contestId ?? (await currentOpenContest(ctx, m.id));
  if (!contestId) return fail("not_open", "No contest is open for voting", 423);
  return { member: { cardNo: m.cardNo }, ballot: await ballotView(ctx, m.id, contestId) };
}

export async function webVote(ctx: Ctx, input: { phone: string; pin: string; contestId: string; choices: Record<string, string | null> }) {
  const m = await verifyPin(ctx, input.phone, input.pin);
  return castBallot(ctx, { memberId: m.id, contestId: input.contestId, choices: input.choices, channel: "web", notifyPhone: input.phone });
}

/**
 * A ward agent helps a member vote in person. The member types their own PIN on the agent's device (the agent never learns it from
 * this code), the member must belong to the agent's ward, and the ballot records the agent's id so assisted votes can be audited.
 */
export async function agentVote(ctx: Ctx, agent: Admin, input: { phone: string; pin: string; contestId: string; choices: Record<string, string | null> }) {
  if (agent.role !== "ward_agent") return fail("forbidden", "Only ward agents can help a member vote", 403);
  const m = await verifyPin(ctx, input.phone, input.pin);
  const ward = (await ctx.db.query<{ ward: string | null }>("SELECT ward FROM members WHERE id=$1", [m.id]))[0]?.ward;
  if (!ward || ward !== agent.ward) return fail("wrong_ward", "Agent can only help members of their own ward", 403);
  const row = (await ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.id]))[0];
  const unit = row ? String((await ctx.keys.decrypt<Record<string, string>>(m.id, row.record_enc)).polling_unit ?? "") || null : null;
  return castBallot(ctx, { memberId: m.id, contestId: input.contestId, choices: input.choices, channel: "agent", agentId: agent.id, notifyPhone: input.phone, unit });
}

// ---- Tally ------------------------------------------------------------------------------------

interface RaceTally { raceId: string; office: string; scope: string; ballots: number; abstained: number; eligible: number; candidates: { candidacyId: string; name: string; votes: number }[]; winnerId: string | null; tie: boolean }

async function tallyWith(db: Db, contestId: string): Promise<RaceTally[]> {
  const c = (await db.query<{ register_id: string | null }>("SELECT register_id FROM contests WHERE id=$1", [contestId]))[0];
  const eligible = c?.register_id ? Number((await db.query<{ member_count: number }>("SELECT member_count FROM registers WHERE id=$1", [c.register_id]))[0]?.member_count ?? 0) : 0;
  const races = await db.query<{ id: string; office: string; scope: string }>("SELECT id, office, scope FROM races WHERE contest_id=$1 ORDER BY created_at, id", [contestId]);
  const out: RaceTally[] = [];
  for (const r of races) {
    const counts = await db.query<{ candidacy_id: string | null; n: number }>("SELECT candidacy_id, COUNT(*)::int AS n FROM ballots WHERE race_id=$1 GROUP BY candidacy_id", [r.id]);
    const abstained = counts.find((x) => x.candidacy_id === null)?.n ?? 0;
    const ks = await db.query<{ id: string; display_name: string }>("SELECT id, display_name FROM candidacies WHERE race_id=$1 AND state='listed' ORDER BY registered_at, id", [r.id]);
    const candidates = ks.map((k) => ({ candidacyId: k.id, name: k.display_name, votes: counts.find((x) => x.candidacy_id === k.id)?.n ?? 0 }));
    const top = Math.max(0, ...candidates.map((x) => x.votes));
    const leaders = top > 0 ? candidates.filter((x) => x.votes === top) : [];
    out.push({ raceId: r.id, office: r.office, scope: r.scope, ballots: counts.reduce((s, x) => s + x.n, 0), abstained, eligible,
      candidates, winnerId: leaders.length === 1 ? leaders[0].candidacyId : null, tie: leaders.length > 1 });
  }
  return out;
}

/**
 * Results are secret while voting is open (no running totals: they pressure voters and let anyone steer a late campaign), and public
 * once the contest is closed. A tie is reported as a tie; breaking it is the party's constitution's job, not this code's.
 */
export async function results(ctx: Ctx, contestId: string) {
  const c = await contestRow(ctx.db, contestId);
  if (c.state !== "closed") return fail("results_not_ready", "Results are published when the contest closes", 423);
  if (await isSealed(ctx.db, contestId)) return { contestId, name: c.name, ...(await encryptedResults(ctx, contestId)) };
  return { contestId, name: c.name, races: await tallyWith(ctx.db, contestId) };
}

/** Called inside the close transaction so the state change and the published results commit together. */
export async function publishResults(ctx: Ctx, tx: Db, contestId: string): Promise<void> {
  if (await isSealed(tx, contestId)) return; // a secret ballot is counted by the guardians (secret-ballot.ts openTally), not here
  for (const r of await tallyWith(tx, contestId)) {
    await ctx.events.emit(tx, { type: "race.turnout", data: { contest_id: contestId, race_id: r.raceId, ballots: r.ballots, abstained: r.abstained, eligible: r.eligible } });
    for (const k of r.candidates) await ctx.events.emit(tx, { type: "race.result", data: { contest_id: contestId, race_id: r.raceId, candidacy_id: k.candidacyId, votes: k.votes } });
  }
}
