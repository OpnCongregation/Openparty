import { generateKeyPairSync, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "./context.js";
import { DAY } from "./context.js";
import { registerAdmin, type Role } from "./admin.js";
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

  app.post("/demo/seed", async () => {
    const tag = randomInt(100, 999);
    const roles: { role: Role; ward?: string }[] = [
      { role: "secretary" }, { role: "electoral_committee" }, { role: "auditor" }, { role: "treasurer" }, { role: "tribunal" }, { role: "ward_agent", ward: "W1" },
    ];
    const admins = [];
    for (const r of roles) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
      const name = `${r.role}-${tag}`;
      const id = await registerAdmin(ctx, { name, role: r.role, ward: r.ward, publicKeyHex });
      admins.push({ id, name, role: r.role, ward: r.ward ?? null, privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") });
    }
    const agent = { id: admins[5].id, role: "ward_agent", ward: "W1" };
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
