import { createHash } from "node:crypto";
import { join } from "node:path";
import { Group } from "@semaphore-protocol/group";
import { Identity } from "@semaphore-protocol/identity";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";
import type { Ctx } from "./context.js";
import type { Db } from "./db.js";
import { fail } from "./errors.js";

/**
 * The anonymous membership proof (Semaphore, zero-knowledge). What it buys, in one sentence: a ballot can prove "I am on this contest's
 * register, and I have not voted under any other name" WITHOUT saying which member it is, so the database and the platform's own secrets
 * cannot link a ballot to a person. We use the Semaphore project's circuits, packages and trusted-setup artifacts (pinned by hash in
 * scripts/fetch-semaphore-artifacts.mjs); nothing here is cryptography of our own.
 *
 * Each member has ONE identity (a secret only its holder knows) and the public "commitment" to it:
 *  - DEVICE identity: made in the member's browser. The platform only ever sees the commitment. Casting is then fully anonymous: no login.
 *  - ASSISTED identity: for voters who cannot make proofs themselves (USSD, polling-unit terminal). The secret is derived from the
 *    platform's permanent reference key and the member id, used in memory to make the proof, and dropped. Whoever holds that key can
 *    re-derive it, so for these voters the link is protected by the operator's controls (and, later, an HSM), not by mathematics.
 * When an election is sealed the commitments of everyone on the frozen register are put in a group (sorted, so position says nothing).
 * A ballot's proof names that group's root, the contest as its scope (so the same person gets the same nullifier in this contest only)
 * and the ballot's own id as its message (so a proof cannot be reused for a different ballot).
 */

/** The package does not export its proof type from the top level, so take it from the function that makes one. */
export type SemaphoreProof = Awaited<ReturnType<typeof generateProof>>;

export interface SemaphoreConfig { depth: number; artifactsDir: string }

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The scope and message numbers. The portal computes the same two functions in the browser, so keep them byte for byte identical. */
export const scopeOf = (contestId: string): bigint => BigInt("0x" + sha(`openparty-scope|${contestId}`).slice(0, 60));
export const messageOf = (ballotId: string): bigint => BigInt("0x" + sha(`openparty-ballot|${ballotId}`).slice(0, 60));

export function semOf(ctx: Ctx): SemaphoreConfig {
  return ctx.semaphore ?? fail("semaphore_unavailable", "Anonymous voting is not configured on this platform", 503);
}
const artifacts = (cfg: SemaphoreConfig) => ({ wasm: join(cfg.artifactsDir, `semaphore-${cfg.depth}.wasm`), zkey: join(cfg.artifactsDir, `semaphore-${cfg.depth}.zkey`) });

/** The identity the platform derives for a member who votes by USSD or at a terminal. Stable for ever (the reference key never rotates). */
export function deriveIdentity(ctx: Ctx, memberId: string): Identity {
  return new Identity(Uint8Array.from(Buffer.from(ctx.keys.refHash("semaphore-identity", memberId), "hex")));
}

export const isCommitment = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^[1-9]\d{0,76}$/.test(s)) return false;
  return BigInt(s) < FIELD;
};

export type IdentityMode = "device" | "assisted";

/**
 * A member registers the commitment of an identity made on their OWN device. Only the commitment is sent; the secret never leaves the
 * device. Allowed until a contest's group that includes the member has been built (after that the group is fixed).
 */
export async function registerDeviceCommitment(ctx: Ctx, memberId: string, commitment: string) {
  if (!isCommitment(commitment)) return fail("bad_commitment", "That is not a valid identity commitment", 422);
  const derived = deriveIdentity(ctx, memberId).commitment.toString();
  if (commitment === derived) return fail("bad_commitment", "That commitment is the platform's own; make one on your device", 422);
  await ctx.commit(async (tx) => {
    const m = await tx.query<{ state: string }>("SELECT state FROM members WHERE id=$1", [memberId]);
    if (!m.length || m[0].state !== "active") return fail("not_active", "Only active members can register an identity", 403);
    const locked = await tx.query(
      `SELECT 1 FROM register_members rm JOIN contests c ON c.register_id=rm.register_id JOIN semaphore_groups g ON g.contest_id=c.id
       WHERE rm.member_id=$1 AND c.state <> 'closed' LIMIT 1`, [memberId]);
    if (locked.length) return fail("identity_locked", "A contest you are in has already fixed its voters; your identity cannot change until it closes", 409);
    const clash = await tx.query("SELECT 1 FROM identity_commitments WHERE commitment=$1 AND member_id <> $2", [commitment, memberId]);
    if (clash.length) return fail("bad_commitment", "That identity is already registered", 409);
    await tx.query(
      `INSERT INTO identity_commitments(member_id, commitment, mode, registered_at) VALUES ($1,$2,'device',$3)
       ON CONFLICT (member_id) DO UPDATE SET commitment=EXCLUDED.commitment, mode='device', registered_at=EXCLUDED.registered_at`, [memberId, commitment, ctx.clock().toISOString()]);
  });
}

/** A member who lost their device goes back to the platform-derived identity (a ward agent does this in person, before the group is built). */
export async function resetToAssisted(ctx: Ctx, memberId: string) {
  await ctx.commit(async (tx) => {
    const locked = await tx.query(
      `SELECT 1 FROM register_members rm JOIN contests c ON c.register_id=rm.register_id JOIN semaphore_groups g ON g.contest_id=c.id
       WHERE rm.member_id=$1 AND c.state <> 'closed' LIMIT 1`, [memberId]);
    if (locked.length) return fail("identity_locked", "A contest this member is in has already fixed its voters", 409);
    await tx.query("DELETE FROM identity_commitments WHERE member_id=$1", [memberId]);
  });
}

export async function modeOf(db: Db, memberId: string): Promise<IdentityMode> {
  const r = await db.query<{ mode: IdentityMode }>("SELECT mode FROM identity_commitments WHERE member_id=$1", [memberId]);
  return r[0]?.mode ?? "assisted";
}

export interface GroupRow { contest_id: string; depth: number; root: string; size: number; commitments: string[] }
export async function groupOf(db: Db, contestId: string): Promise<GroupRow | null> {
  const r = await db.query<{ contest_id: string; depth: number; root: string; size: number; commitments: string }>("SELECT * FROM semaphore_groups WHERE contest_id=$1", [contestId]);
  return r[0] ? { ...r[0], depth: Number(r[0].depth), size: Number(r[0].size), commitments: JSON.parse(r[0].commitments) as string[] } : null;
}

/**
 * Fix the contest's group from the frozen register: every member on it contributes their commitment (the platform makes the assisted
 * ones now). Sorted by value so that the position in the tree reveals nothing about who it is. Runs inside the sealing transaction.
 */
export async function buildGroup(ctx: Ctx, tx: Db, contestId: string, registerId: string): Promise<{ size: number; depth: number; rootHex: string }> {
  const cfg = semOf(ctx);
  const members = await tx.query<{ member_id: string; commitment: string | null }>(
    `SELECT rm.member_id, ic.commitment FROM register_members rm LEFT JOIN identity_commitments ic ON ic.member_id=rm.member_id WHERE rm.register_id=$1`, [registerId]);
  if (!members.length) return fail("empty_register", "The register has no members, so there is no one to vote", 409);
  const list: bigint[] = [];
  for (const m of members) {
    let c = m.commitment;
    if (!c) {
      c = deriveIdentity(ctx, m.member_id).commitment.toString();
      await tx.query("INSERT INTO identity_commitments(member_id, commitment, mode, registered_at) VALUES ($1,$2,'assisted',$3) ON CONFLICT (member_id) DO NOTHING", [m.member_id, c, ctx.clock().toISOString()]);
    }
    list.push(BigInt(c));
  }
  if (new Set(list.map(String)).size !== list.length) return fail("duplicate_identity", "Two members share an identity commitment", 409);
  if (members.length > 2 ** cfg.depth) return fail("group_too_big", `The register has ${members.length} members; depth ${cfg.depth} allows ${2 ** cfg.depth}`, 409);
  list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const group = new Group(list);
  const root = group.root.toString();
  await tx.query("INSERT INTO semaphore_groups(contest_id, depth, root, size, commitments, built_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [contestId, cfg.depth, root, list.length, JSON.stringify(list.map(String)), ctx.clock().toISOString()]);
  return { size: list.length, depth: cfg.depth, rootHex: BigInt(root).toString(16).padStart(64, "0") };
}

const toGroup = (g: GroupRow) => new Group(g.commitments.map((c) => BigInt(c)));

/** Make the proof for a member whose identity the platform derives (USSD, terminal). The secret exists in memory for this call only. */
export async function proveAssisted(ctx: Ctx, memberId: string, contestId: string, ballotId: string, g: GroupRow): Promise<SemaphoreProof> {
  const cfg = semOf(ctx);
  if (await modeOf(ctx.db, memberId) === "device")
    return fail("use_device", "You registered an identity on your own device: vote from that device", 409);
  const id = deriveIdentity(ctx, memberId);
  if (!g.commitments.includes(id.commitment.toString())) return fail("not_eligible", "You are not in this contest's group of voters", 403);
  return generateProof(id, toGroup(g), messageOf(ballotId), scopeOf(contestId), g.depth, artifacts(cfg));
}

/**
 * Check a proof against this contest's group, scope and ballot id. Returns its nullifier. Throws a plain refusal for anything that does
 * not verify; never trusts a field of the proof that the group does not confirm.
 */
export async function checkProof(contestId: string, ballotId: string, proof: unknown, g: GroupRow): Promise<string> {
  const p = proof as SemaphoreProof;
  const isNum = (x: unknown) => typeof x === "string" && /^\d{1,78}$/.test(x);
  if (!p || typeof p !== "object" || !isNum(p.merkleTreeRoot) || !isNum(p.nullifier) || !isNum(p.message) || !isNum(p.scope) || !Array.isArray(p.points) || p.points.length !== 8 || !p.points.every(isNum)
    || Number(p.merkleTreeDepth) !== g.depth)
    return fail("bad_proof", "The membership proof is malformed", 422);
  if (p.merkleTreeRoot !== g.root) return fail("bad_proof", "The proof is not for this contest's group of voters", 422);
  if (p.scope !== scopeOf(contestId).toString()) return fail("bad_proof", "The proof is for a different contest", 422);
  if (p.message !== messageOf(ballotId).toString()) return fail("bad_proof", "The proof is for a different ballot", 422);
  let ok = false;
  try { ok = await verifyProof(p); } catch { ok = false; }
  if (!ok) return fail("bad_proof", "The membership proof does not verify", 422);
  return p.nullifier;
}
