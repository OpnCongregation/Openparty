import Fastify from "fastify";
import type { Ctx } from "./context.js";
import { DomainError } from "./errors.js";
import * as admin from "./admin.js";
import * as members from "./members.js";
import * as contests from "./contests.js";
import { completeRecord } from "./record-notices.js";
import * as election from "./election.js";
import * as sb from "./secret-ballot.js";
import { PgLimiter } from "./ratelimit.js";
import { registerDemo, type DemoClock } from "./demo.js";
import * as finance from "./finance.js";
import * as participation from "./participation.js";
import { registerUssd, type UssdOptions } from "./ussd-guard.js";
import { registerFramework } from "./framework/api.js";

export interface ServerOptions {
  ussd?: UssdOptions;
  /** Believe X-Forwarded-For. Only behind a reverse proxy you control; otherwise callers could forge their address. */
  trustProxy?: boolean;
  /** DEMO_MODE only: a movable clock plus seeding routes (demo.ts). Never set for real members. */
  demo?: DemoClock;
}

export function buildServer(ctx: Ctx, opts: ServerOptions = {}) {
  const app = Fastify({ trustProxy: opts.trustProxy ?? false });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))));
  // Keep the exact body text: admin signatures cover its hash.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e: any) { e.statusCode = 400; done(e); }
  });

  app.addHook("onSend", async (_req, reply) => { reply.header("Access-Control-Allow-Origin", "*"); });
  // Browser pages (the portal) call this API directly: answer the preflight for JSON posts and signed admin requests.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "OPTIONS") return;
    return reply.code(204)
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "content-type, x-admin-id, x-timestamp, x-signature")
      .header("Access-Control-Max-Age", "600")
      .send();
  });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof DomainError) return reply.status(e.status).send({ error: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) });
    app.log.error(e);
    return reply.status(e.statusCode ?? 500).send({ error: "internal", message: e.statusCode ? e.message : "Internal error" });
  });

  /** Signature-authenticated admin route. Each call is access-logged. */
  const guarded = (perm: string | null, fn: (a: admin.Admin, req: any) => Promise<unknown>) => async (req: any, reply: any) => {
    const h = req.headers;
    const a = await admin.authenticate(ctx, { adminId: h["x-admin-id"], ts: h["x-timestamp"], sig: h["x-signature"] }, req.method, req.url, req.rawBody ?? "");
    if (perm) admin.require_(a, perm);
    // Log the route PATTERN (/admin/approvals/:id/approve), not the URL: ids in a URL are UUIDs, and a UUID with a long run of digits
    // is refused by the public-log guard (it looks like a phone number), which used to fail the request itself at random.
    await admin.logAccess(ctx, a.id, `${req.method} ${req.routeOptions?.url ?? req.url.split("?")[0]}`);
    return reply.send(await fn(a, req));
  };

  // Server time, so a browser that signs admin requests can use the platform's clock (which a demo can move) instead of its own.
  // What this deployment can do, so the screens know whether to show the guardian steps.
  app.get("/public/config", async () => ({ secretBallot: !!ctx.eg, plainBallotAllowed: process.env.ALLOW_PLAIN_BALLOT === "1", demoGuardians: !!ctx.eg?.guardian }));
  app.get("/public/time", async () => ({ now: ctx.clock().toISOString() }));
  if (opts.demo) registerDemo(app, ctx, opts.demo);

  // "degraded" = committed events are waiting too long to reach the public log (the log is down or refusing them).
  app.get("/healthz", async () => {
    const outbox = await ctx.events.stats();
    const late = outbox.oldestPendingSeconds !== null && outbox.oldestPendingSeconds > 60;
    const stuck = (await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM approvals WHERE status='executing' AND claimed_at < $1", [new Date(Date.now() - 120_000).toISOString()]))[0].n;
    return { status: late || stuck > 0 ? "degraded" : "ok", outbox, approvalsStuck: stuck };
  });

  // USSD gateway webhook (Africa's Talking format): authenticated, validated and rate limited. See ussd-guard.ts.
  registerUssd(app, ctx, opts.ussd ?? {});

  // ---- Elections: public views, member self-service (phone + PIN, throttled per address and per member), admin and agent routes ----
  const voteLimit = new PgLimiter(ctx.db, "vote-web", 60, 60_000);
  const PHONE = /^\+?\d{8,15}$/;
  const member = (fn: (b: any) => Promise<unknown>) => async (req: any, reply: any) => {
    if (!(await voteLimit.take(req.ip))) return reply.code(429).header("Retry-After", 60).send({ error: "rate_limited" });
    const b = req.body ?? {};
    if (typeof b.phone !== "string" || !PHONE.test(b.phone) || typeof b.pin !== "string" || !/^\d{4}$/.test(b.pin)) return reply.code(400).send({ error: "bad_request", message: "Phone number and 4-digit PIN required" });
    return reply.send(await fn(b));
  };
  app.get("/public/election/:contestId", async (req) => election.listElection(ctx, (req.params as any).contestId));
  app.get("/public/election/:contestId/results", async (req) => election.results(ctx, (req.params as any).contestId));
  app.post("/election/ballot", member((b) => election.webBallot(ctx, b)));
  app.post("/election/vote", member((b) => election.webVote(ctx, b)));
  app.post("/election/apply", member((b) => election.registerCandidate(ctx, b)));
  app.post("/election/pay-form", member((b) => election.payForm(ctx, b)));
  app.post("/election/withdraw", member((b) => election.withdrawCandidate(ctx, b).then(() => ({ ok: true }))));
  app.post("/election/mine", member((b) => election.myCandidacies(ctx, b)));
  // The secret ballot. Public record and audit (anyone), the guardians' own steps (signed, appointed guardians only), tally and paper counts.
  app.get("/public/election/:contestId/record", async (req) => sb.publicRecord(ctx, (req.params as any).contestId));
  app.get("/public/election/:contestId/ballots", async (req) => {
    const q = (req.query ?? {}) as { after?: string; limit?: string };
    return sb.publicBallots(ctx, (req.params as any).contestId, q.after, Number(q.limit ?? 100));
  });
  app.get("/public/election/:contestId/audit", async (req) => sb.paperAudit(ctx, (req.params as any).contestId));
  app.get("/public/election/:contestId/verify", async (req) => sb.verifyRecord(ctx, (req.params as any).contestId));
  app.get("/guardian/ceremony/:contestId", guarded("guardian.act", (a, req) => sb.ceremonyView(ctx, a, req.params.contestId)));
  app.post("/guardian/ceremony/:contestId/key", guarded("guardian.act", (a, req) => sb.postKey(ctx, a, req.params.contestId, req.body?.public).then(() => ({ ok: true }))));
  app.post("/guardian/ceremony/:contestId/backups", guarded("guardian.act", (a, req) => sb.postBackups(ctx, a, req.params.contestId, req.body?.backups).then(() => ({ ok: true }))));
  app.post("/guardian/ceremony/:contestId/verify", guarded("guardian.act", (a, req) => sb.postVerification(ctx, a, req.params.contestId, req.body ?? {})));
  app.post("/guardian/shares/:contestId/:set", guarded("guardian.act", (a, req) => sb.submitShares(ctx, a, req.params.contestId, req.params.set, req.body)));
  app.post("/admin/contests/:contestId/tally", guarded("tally.prepare", async (_a, req) => {
    const out = await sb.prepareTally(ctx, req.params.contestId, "all");
    // the polling-unit total is prepared too when any ballots were cast at units, so the paper can be checked against it
    const agentBallots = Number((await ctx.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM enc_ballots WHERE contest_id=$1 AND channel='agent' AND NOT superseded", [req.params.contestId]))[0].n);
    const unitTotal = agentBallots > 0 ? await sb.prepareTally(ctx, req.params.contestId, "agent") : null;
    return { all: out, units: unitTotal };
  }));
  app.post("/agent/paper-count", guarded("member.activate", (a, req) => sb.submitPaperCount(ctx, a, req.body ?? {}).then(() => ({ ok: true }))));
  app.post("/agent/vote", guarded("member.activate", (a, req) => election.agentVote(ctx, a, req.body ?? {})));
  app.post("/admin/races", guarded("race.manage", (a, req) => election.createRace(ctx, a, req.body ?? {})));
  app.post("/admin/candidates/:id/stamp", guarded("candidate.stamp", (a, req) => election.stampCandidate(ctx, a, req.params.id, req.body?.verdict, req.body?.note).then(() => ({ ok: true }))));
  app.get("/admin/election/:contestId", guarded("candidate.stamp", (_a, req) => election.listElection(ctx, req.params.contestId, { admin: true })));

  // Ward agent
  app.post("/agent/activate", guarded("member.activate", (a, req) => members.activateMember(ctx, a, req.body).then(() => ({ ok: true }))));

  app.post("/agent/complete-record", guarded("member.activate", (a, req) => completeRecord(ctx, req.body.memberId, req.body.fields ?? {}, { agent: a })));
  app.post("/agent/unlock-pin", guarded("member.activate", (a, req) => members.unlockPin(ctx, a, req.body.memberId).then(() => ({ ok: true }))));

  // Admin
  app.post("/admin/contests", guarded("contest.create", async (_a, req) => ({ id: await contests.createContest(ctx, { ...req.body, voteDate: new Date(req.body.voteDate) }) })));
  app.post("/admin/contests/:id/notice", guarded("notice.generate", (_a, req) => contests.generateNotice(ctx, req.params.id)));
  app.post("/admin/contests/:id/notice-receipt", guarded("receipt.record", (_a, req) => contests.recordNoticeReceipt(ctx, req.params.id, req.body.receipt).then(() => ({ ok: true }))));
  app.post("/admin/registers/:id/receipt", guarded("receipt.record", (_a, req) => contests.recordRegisterReceipt(ctx, req.params.id, req.body.receipt).then(() => ({ ok: true }))));
  app.get("/admin/contests/:id/register-check", guarded("register.read", (_a, req) => contests.previewRegister(ctx, req.params.id)));
  app.get("/admin/registers/:id/export", guarded("register.read", (_a, req) => contests.exportRegister(ctx, req.params.id)));
  app.post("/admin/approvals", guarded("approval.propose", async (a, req) => ({ id: await admin.propose(ctx, a, req.body.action, req.body.payload) })));
  app.post("/admin/approvals/:id/approve", guarded("approval.approve", (a, req) => admin.approve(ctx, a, req.params.id)));
  app.post("/admin/gifts", guarded("gift.record", (_a, req) => finance.recordGift(ctx, req.body.payment, req.body.donor)));
  app.get("/admin/finance/donors", guarded("finance.report", () => finance.donorReport(ctx)));
  app.post("/admin/finance/retry-payments", guarded("finance.retry", () => finance.retryUnrecorded(ctx)));
  app.get("/admin/finance/reconcile", guarded("finance.report", () => finance.reconcile(ctx)));

  // Public
  app.get("/public/proposals/:id", async (req) => participation.proposalStatus(ctx, (req.params as any).id));
  app.get("/public/contests", async () => ctx.db.query("SELECT id,name,primary_type,mode,vote_date,state,notice_at,rules_hash FROM contests ORDER BY vote_date"));
  app.get("/public/registers/:contestId", async (req) =>
    ctx.db.query("SELECT id,contest_id,frozen_at,fingerprint,member_count,(inec_receipt IS NOT NULL) AS filed FROM registers WHERE contest_id=$1", [(req.params as any).contestId]));

  registerFramework(app, ctx);

  return app;
}
