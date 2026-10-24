import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signingString } from "../src/admin.js";
import { demoClockFn } from "../src/demo.js";
import { createCtx } from "../src/platform.js";
import { MemoryTrustLog } from "../src/adapters.js";
import { buildServer } from "../src/server.js";

/** The whole election over HTTP, the way the portal screens do it: demo seed, signed admin calls, member and agent voting, results. */
describe("an election end to end over HTTP (demo mode)", () => {
  it("seed -> races -> candidates -> approvals -> vote date -> web, agent and USSD votes -> approved close -> results", async () => {
    const demo = { offsetMs: 0 };
    const log = new MemoryTrustLog();
    const ctx = await createCtx({ clock: demoClockFn(demo), log });
    const app = buildServer(ctx, { demo, ussd: { sim: true } });

    const call = async (method: "GET" | "POST", url: string, body?: unknown, who?: any) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = payload ? { "content-type": "application/json" } : {};
      if (who) {
        const ts = String(ctx.clock().getTime());
        const key = createPrivateKey({ key: Buffer.from(who.privateKey, "base64"), format: "der", type: "pkcs8" });
        Object.assign(headers, { "x-admin-id": who.id, "x-timestamp": ts, "x-signature": sign(null, Buffer.from(signingString(ts, method, url, payload ?? "")), key).toString("hex") });
      }
      const r = await app.inject({ method, url, payload, headers });
      if (r.statusCode >= 500) console.log("HTTP", r.statusCode, method, url, r.body);
      return { status: r.statusCode, body: r.body ? (r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body) : null as any };
    };

    // CORS preflight for a signed JSON post
    const pre = await app.inject({ method: "OPTIONS", url: "/admin/races", headers: { origin: "http://localhost:3001", "access-control-request-method": "POST" } });
    expect(pre.statusCode).toBe(204);
    expect(String(pre.headers["access-control-allow-headers"])).toContain("x-signature");

    const seed = (await call("POST", "/demo/seed")).body;
    const by = (role: string) => seed.admins.find((a: any) => a.role === role);
    const [sec, ec, aud, agent] = [by("secretary"), by("electoral_committee"), by("auditor"), by("ward_agent")];
    const cid = seed.contestId;
    const m = seed.members;

    expect((await call("POST", "/admin/races", { contestId: cid, office: "National Chairman", formFeeMinor: 0 }, by("treasurer"))).status).toBe(403);
    const race = (await call("POST", "/admin/races", { contestId: cid, office: "National Chairman", formFeeMinor: 0 }, sec)).body.raceId;
    const apply = (i: number) => call("POST", "/election/apply", { phone: m[i].phone, pin: m[i].pin, raceId: race, consentPublic: true });
    const c1 = (await apply(0)).body.candidacyId, c2 = (await apply(1)).body.candidacyId;
    expect((await call("POST", `/admin/candidates/${c1}/stamp`, { verdict: "vetted", note: "ok" }, aud)).status).toBe(200);

    const pub = (await call("GET", `/public/election/${cid}`)).body;
    expect(pub.races[0].candidates.map((c: any) => c.status).sort()).toEqual(["unvetted", "vetted"]);

    // setup gates through approvals, as in production
    expect((await call("POST", `/admin/contests/${cid}/notice-receipt`, { receipt: "INEC-N-DEMO1" }, sec)).status).toBe(200);
    const approvals = async (action: string, payload: unknown, proposer: any, approvers: any[]) => {
      const id = (await call("POST", "/admin/approvals", { action, payload }, proposer)).body.id;
      for (const a of approvers) expect((await call("POST", `/admin/approvals/${id}/approve`, undefined, a)).status).toBe(200);
    };
    await approvals("register.freeze", { contestId: cid }, sec, [ec, aud]);
    const reg = (await call("GET", `/public/registers/${cid}`)).body[0];
    expect(reg.member_count).toBe(8);
    expect((await call("POST", `/admin/registers/${reg.id}/receipt`, { receipt: "INEC-R-DEMO1" }, sec)).status).toBe(200);

    // voting cannot start before the vote date, however many approvals there are
    const early = (await call("POST", "/admin/approvals", { action: "contest.open", payload: { contestId: cid } }, ec)).body.id;
    await call("POST", `/admin/approvals/${early}/approve`, undefined, sec);
    expect((await call("POST", `/admin/approvals/${early}/approve`, undefined, aud)).status).toBe(425);

    expect((await call("POST", "/demo/advance", { days: 30 })).body.offsetDays).toBe(30);
    await approvals("contest.open", { contestId: cid }, ec, [sec, aud]);
    expect((await call("GET", "/public/contests")).body.find((c: any) => c.id === cid).state).toBe("open");

    // web: the ballot, then the vote
    const b = (await call("POST", "/election/ballot", { phone: m[2].phone, pin: m[2].pin })).body;
    expect(b.ballot).toMatchObject({ open: true, eligible: true });
    expect(b.ballot.races[0].candidates).toHaveLength(2);
    expect((await call("POST", "/election/vote", { phone: m[2].phone, pin: m[2].pin, contestId: cid, choices: { [race]: c1 } })).status).toBe(200);
    expect((await call("POST", "/election/vote", { phone: m[2].phone, pin: "0000", contestId: cid, choices: { [race]: c1 } })).status).toBe(401);
    expect((await call("POST", "/election/vote", { phone: "nope", pin: "1234", contestId: cid, choices: {} })).status).toBe(400);
    // agent-assisted, then USSD
    expect((await call("POST", "/agent/vote", { phone: m[3].phone, pin: m[3].pin, contestId: cid, choices: { [race]: c2 } }, agent)).status).toBe(200);
    const sim = async (text: string) => (await app.inject({ method: "POST", url: "/ussd/sim", payload: new URLSearchParams({ phoneNumber: m[4].phone, text }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } })).body;
    expect(await sim(`5*${m[4].pin}*1*1`)).toMatch(/^END Vote counted/);
    expect((await call("GET", `/public/election/${cid}/results`)).status).toBe(423); // hidden while open

    await approvals("contest.close", { contestId: cid }, ec, [sec, aud]);
    const res = (await call("GET", `/public/election/${cid}/results`)).body;
    expect(res.races[0]).toMatchObject({ ballots: 3, eligible: 8, tie: false, winnerId: c1 });
    expect(res.races[0].candidates.map((c: any) => c.votes).sort()).toEqual([1, 2]);
    expect((await call("POST", "/election/vote", { phone: m[5].phone, pin: m[5].pin, contestId: cid, choices: { [race]: c1 } })).status).toBe(423);

    await ctx.events.flush();
    // The access log records route patterns, never concrete ids (a digit-heavy UUID used to make the log guard refuse the request).
    const actions = (await ctx.db.query<any>("SELECT DISTINCT action FROM access_log")).map((r: any) => r.action);
    expect(actions).toContain("POST /admin/approvals/:id/approve");
    expect(actions.every((a: string) => !/[0-9a-f]{8}-[0-9a-f]{4}/.test(a))).toBe(true);
    const types = new Set(log.events.map((e: any) => e.type));
    for (const t of ["race.created", "candidate.registered", "candidate.listed", "candidate.stamped", "ballot.cast", "race.turnout", "race.result", "contest.closed"]) expect(types.has(t)).toBe(true);
  });
});
