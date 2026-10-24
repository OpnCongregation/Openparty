import { generateKeyPairSync, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "./context.js";
import { DAY } from "./context.js";
import { registerAdmin, type Admin, type Role } from "./admin.js";
import { fail } from "./errors.js";
import * as sb from "./secret-ballot.js";
import * as contests from "./contests.js";
import { activateMember, confirmJoin, prepareJoin } from "./members.js";

/**
 * DEMO MODE (DEMO_MODE=1). For trying the election screens on a laptop: it seeds demo admins, members and a contest INTO THE REAL
 * DATABASE, hands the demo admins' private keys to the browser, and moves the clock forward so a vote date can arrive. All of that is
 * wrong for a real deployment, so it is off by default and the platform says so loudly when it is on. Never enable it with real members.
 */
export interface DemoClock { offsetMs: number }

export const DEMO_PIN = "1234";

export function demoClockFn(c: DemoClock) {
  return () => new Date(Date.now() + c.offsetMs);
}

export function registerDemo(app: FastifyInstance, ctx: Ctx, clock: DemoClock) {
  app.get("/demo/state", async () => ({ demo: true, now: ctx.clock().toISOString(), offsetDays: Math.round(clock.offsetMs / DAY) }));

  app.post("/demo/advance", async (req) => {
    const days = Number((req.body as any)?.days);
    if (!Number.isFinite(days) || days < 0 || days > 120) return { error: "bad_days", message: "days: 0 to 120" };
    clock.offsetMs += days * DAY;
    return { now: ctx.clock().toISOString(), offsetDays: Math.round(clock.offsetMs / DAY) };
  });

  const adminOf = async (id: string): Promise<Admin> => {
    const r = await ctx.db.query<Admin>("SELECT id, name, role, ward FROM admins WHERE id=$1", [id]);
    return r[0] ?? fail("not_found", "No such admin", 404);
  };

  /**
   * DEMO ONLY. Runs all five guardians' key-ceremony steps in this process, so a trial can show the whole election in a browser. In a real
   * election each guardian does this on their own device with the guardian tool and the platform never sees a private key. Here the
   * private states are handed back to the browser (like the demo admins' keys) so the guardians can open the tally later.
   */
  app.post("/demo/guardians/ceremony", async (req) => {
    const eg = ctx.eg?.guardian ?? fail("guardian_ops_off", "Start the platform and the electionguard service with EG_DEMO_GUARDIANS=1", 409);
    const { contestId } = (req.body ?? {}) as { contestId?: string };
    const gs = await ctx.db.query<{ admin_id: string; position: number }>("SELECT admin_id, position FROM guardians WHERE contest_id=$1 ORDER BY position", [contestId]);
    if (gs.length !== sb.GUARDIANS) return fail("no_guardians", "Appoint the five guardians first (an approved action)", 409);
    const admins = await Promise.all(gs.map((g) => adminOf(g.admin_id)));
    const priv: Record<string, string> = {};
    for (const [i, a] of admins.entries()) {
      const k = await eg.init(a.id, i + 1, sb.GUARDIANS, sb.QUORUM);
      priv[a.id] = k.private;
      await sb.postKey(ctx, a, contestId!, k.public);
    }
    for (const a of admins) {
      const v = await sb.ceremonyView(ctx, a, contestId!);
      const out = await eg.backups(priv[a.id], v.publicKeys);
      priv[a.id] = out.private;
      await sb.postBackups(ctx, a, contestId!, out.backups);
    }
    let complete = false;
    for (const a of admins) {
      const v = await sb.ceremonyView(ctx, a, contestId!);
      const out = await eg.receive(priv[a.id], v.backupsForMe);
      priv[a.id] = out.private;
      complete = (await sb.postVerification(ctx, a, contestId!, out)).complete;
    }
    return { states: priv, complete };
  });

  /** DEMO ONLY. The named guardians post their shares of a tally (made here from the private states the browser kept). */
  app.post("/demo/guardians/shares", async (req) => {
    const eg = ctx.eg?.guardian ?? fail("guardian_ops_off", "Start the platform and the electionguard service with EG_DEMO_GUARDIANS=1", 409);
    const b = (req.body ?? {}) as { contestId: string; set?: string; adminIds: string[]; states: Record<string, string> };
    const set = b.set ?? "all";
    const rec = await sb.publicRecord(ctx, b.contestId);
    const tally = rec.tallies.find((t) => t.set === set)?.tally ?? fail("no_tally", "Prepare the tally first", 409);
    let last: unknown = null;
    for (const id of b.adminIds) {
      const a = await adminOf(id);
      const st = b.states?.[id] ?? fail("no_state", "That guardian's demo key is not in this browser", 409);
      const shares = await eg.shares(st, rec.manifest!, rec.context!, tally, rec.publicKeys as string[]);
      last = await sb.submitShares(ctx, a, b.contestId, set, shares);
    }
    return last;
  });

  app.post("/demo/seed", async () => {
    const tag = randomInt(100, 999);
    // Five electoral-committee members: the guardians of the secret ballot are drawn from them.
    const roles: { role: Role; ward?: string; n?: number }[] = [
      { role: "secretary" }, ...[1, 2, 3, 4, 5].map((n) => ({ role: "electoral_committee" as Role, n })), { role: "auditor" }, { role: "treasurer" }, { role: "tribunal" }, { role: "ward_agent", ward: "W1" },
    ];
    const admins = [];
    for (const r of roles) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
      const name = r.n ? `${r.role}-${tag}-${r.n}` : `${r.role}-${tag}`;
      const id = await registerAdmin(ctx, { name, role: r.role, ward: r.ward, publicKeyHex });
      admins.push({ id, name, role: r.role, ward: r.ward ?? null, privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") });
    }
    const agent = { id: admins.find((a) => a.role === "ward_agent")!.id, role: "ward_agent", ward: "W1" };
    const members = [];
    for (let i = 0; i < 8; i++) {
      const nin = String(10_000_000_000 + randomInt(0, 89_999_999_999));
      const phone = `+23480${tag}${String(i).padStart(2, "0")}${String(randomInt(1000, 9999))}`;
      const { preview } = await prepareJoin(ctx, phone, nin);
      const j = await confirmJoin(ctx, phone, "anonymous", DEMO_PIN);
      await activateMember(ctx, agent, { memberId: j.memberId, ward: "W1", pollingUnit: `PU-00${i % 4}`, photoRef: "photo-1", disabilityStatus: "none" });
      members.push({ phone, pin: DEMO_PIN, cardNo: j.cardNo, preview });
    }
    // Two unfinished contests cannot share a vote date, so a second seed takes the next free day.
    let voteDate = new Date(ctx.clock().getTime() + 30 * DAY);
    let contestId = "";
    for (let tries = 0; !contestId; tries++) {
      try { contestId = await contests.createContest(ctx, { name: `DDPN demo primary ${tag}`, primaryType: "direct", mode: "virtual", voteDate }); }
      catch (e: any) { if (e?.code !== "contest_overlap" || tries > 90) throw e; voteDate = new Date(voteDate.getTime() + DAY); }
    }
    await contests.generateNotice(ctx, contestId);
    return { admins, members, contestId, voteDate: voteDate.toISOString(), now: ctx.clock().toISOString() };
  });
}
