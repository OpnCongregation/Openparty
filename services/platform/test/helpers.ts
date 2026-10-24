import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createCtx, type PlatformOptions } from "../src/platform.js";
import { MemoryTrustLog, SimSms } from "../src/adapters.js";
import { registerAdmin, signingString, type Role } from "../src/admin.js";
import { DAY, type Ctx } from "../src/context.js";
import { activateMember, confirmJoin, prepareJoin } from "../src/members.js";

export const T0 = new Date("2026-11-01T09:00:00Z");

export async function setup(extra: Partial<PlatformOptions> = {}) {
  const state = { now: new Date(T0) };
  const log = new MemoryTrustLog();
  const sms = new SimSms();
  const ctx = await createCtx({ log, sms, clock: () => new Date(state.now), ...extra });
  return { ctx, log, sms, state, advance: (days: number) => (state.now = new Date(state.now.getTime() + days * DAY)) };
}

export async function makeAdmin(ctx: Ctx, role: Role, ward?: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const id = await registerAdmin(ctx, { name: `${role}-${randomUUID().slice(0, 4)}`, role, ward, publicKeyHex: raw });
  const a = { id, name: role, role, ward: ward ?? null };
  const headers = (method: string, path: string, body = "") => {
    const ts = String(ctx.clock().getTime());
    const sig = sign(null, Buffer.from(signingString(ts, method, path, body)), privateKey).toString("hex");
    return { "x-admin-id": id, "x-timestamp": ts, "x-signature": sig };
  };
  return { ...a, headers };
}

let ninCounter = 10_000_000_000;
export const freshNin = () => String(++ninCounter);

/** Join via the same functions the USSD flow uses, then activate through a ward agent. */
export async function joinAndActivate(ctx: Ctx, agent: { id: string; role: string; ward: string | null }, opts: { phone?: string; ward?: string } = {}) {
  const nin = freshNin();
  const phone = opts.phone ?? `+23480${nin.slice(-8)}`;
  await prepareJoin(ctx, phone, nin);
  const j = await confirmJoin(ctx, phone, "anonymous", "1234");
  await activateMember(ctx, agent, {
    memberId: j.memberId, ward: opts.ward ?? agent.ward!, pollingUnit: "PU-001", photoRef: "photo-1", disabilityStatus: "none",
  });
  return { ...j, phone, nin };
}
