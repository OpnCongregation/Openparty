"use client";
import { PLATFORM, call, errorText, store } from "./lib";

/**
 * The voter's side of the anonymous membership proof. The identity (a secret) is made HERE, in the browser, and never sent anywhere:
 * the platform is given only its public commitment. At vote time the proof is also made here, from the public list of voters and the
 * proving files the platform serves, and sent without any login. The heavy libraries are loaded only when a voter actually needs them.
 *
 * scopeOf and messageOf MUST match services/platform/src/semaphore.ts byte for byte.
 */
const sha256hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const scopeOf = async (contestId: string) => BigInt("0x" + (await sha256hex(`openparty-scope|${contestId}`)).slice(0, 60));
export const messageOf = async (ballotId: string) => BigInt("0x" + (await sha256hex(`openparty-ballot|${ballotId}`)).slice(0, 60));

const KEY = "op_identities_v1";
type Saved = Record<string, string>; // phone -> the identity's private export
export const savedIdentities = (): Saved => store.get<Saved>(KEY, {});
export const forgetIdentity = (phone: string) => { const s = savedIdentities(); delete s[phone]; store.set(KEY, s); };

/** Make an identity on this device and register only its public commitment (the member proves who they are once, with their PIN). */
export async function createDeviceIdentity(phone: string, pin: string): Promise<{ ok: true; backup: string } | { ok: false; error: string }> {
  const { Identity } = await import("@semaphore-protocol/identity");
  const id = new Identity();
  const r = await call("POST", "/election/identity", { phone, pin, commitment: id.commitment.toString() });
  if (!r.ok) return { ok: false, error: errorText(r) };
  store.set(KEY, { ...savedIdentities(), [phone]: id.export() });
  return { ok: true, backup: id.export() };
}

/** Bring an identity made on another device (from its backup text). It must be the one registered for this member. */
export async function importDeviceIdentity(phone: string, backup: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { Identity } = await import("@semaphore-protocol/identity");
    const id = Identity.import(backup.trim());
    store.set(KEY, { ...savedIdentities(), [phone]: id.export() });
    return { ok: true };
  } catch { return { ok: false, error: "That does not look like an identity backup." }; }
}

export interface CastOutcome { ok: boolean; receipt?: string; revision?: number; error?: string }

/**
 * Make the membership proof here and cast without logging in. `onStatus` reports the slow part (a few seconds on a phone).
 * The platform sees the choices, the proof and nothing that names the voter.
 */
export async function castAnonymously(contestId: string, choices: Record<string, string | null>, phone: string, onStatus: (s: string) => void): Promise<CastOutcome> {
  const exported = savedIdentities()[phone];
  if (!exported) return { ok: false, error: "This device has no identity for that phone number. Set one up first, or import your backup." };
  onStatus("Loading the list of voters…");
  const [g, cfg] = await Promise.all([call("GET", `/public/election/${contestId}/group`), call("GET", "/public/config")]);
  if (!g.ok || !g.data.commitments) return { ok: false, error: "This election has no group of voters yet (it is not sealed)." };
  const { Identity } = await import("@semaphore-protocol/identity");
  const id = Identity.import(exported);
  if (!g.data.commitments.includes(id.commitment.toString()))
    return { ok: false, error: "Your identity is not in this contest's list of voters. It must be registered before the election is sealed, from the device you vote on." };
  onStatus("Loading the proving files (a few megabytes, once)…");
  const [{ Group }, { generateProof }] = await Promise.all([import("@semaphore-protocol/group"), import("@semaphore-protocol/proof")]);
  const ballotId = crypto.randomUUID();
  onStatus("Making your anonymous proof. This takes a few seconds; nothing leaves your device yet…");
  const depth = g.data.depth as number;
  const proof = await generateProof(id, new Group(g.data.commitments.map((c: string) => BigInt(c))), await messageOf(ballotId), await scopeOf(contestId), depth, {
    wasm: `${PLATFORM}/public/semaphore/${depth}/semaphore.wasm`,
    zkey: `${PLATFORM}/public/semaphore/${depth}/semaphore.zkey`,
  });
  void cfg;
  onStatus("Casting your ballot…");
  const r = await call("POST", "/election/cast", { contestId, ballotId, choices, proof });
  if (!r.ok) return { ok: false, error: errorText(r) };
  return { ok: true, receipt: r.data.receipts[0].receipt, revision: r.data.receipts[0].revision };
}
