import Fastify from "fastify";
import type { Ctx } from "./context.js";
import { DomainError } from "./errors.js";
import * as admin from "./admin.js";
import * as members from "./members.js";
import * as contests from "./contests.js";
import * as finance from "./finance.js";
import * as participation from "./participation.js";
import { registerUssd, type UssdOptions } from "./ussd-guard.js";
import { registerFramework } from "./framework/api.js";

export interface ServerOptions {
  ussd?: UssdOptions;
  /** Believe X-Forwarded-For. Only behind a reverse proxy you control; otherwise callers could forge their address. */
  trustProxy?: boolean;
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
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof DomainError) return reply.status(e.status).send({ error: e.code, message: e.message });
    app.log.error(e);
    return reply.status(e.statusCode ?? 500).send({ error: "internal", message: e.statusCode ? e.message : "Internal error" });
  });

  /** Signature-authenticated admin route. Each call is access-logged. */
  const guarded = (perm: string | null, fn: (a: admin.Admin, req: any) => Promise<unknown>) => async (req: any, reply: any) => {
    const h = req.headers;
    const a = await admin.authenticate(ctx, { adminId: h["x-admin-id"], ts: h["x-timestamp"], sig: h["x-signature"] }, req.method, req.url, req.rawBody ?? "");
    if (perm) admin.require_(a, perm);
    await admin.logAccess(ctx, a.id, `${req.method} ${req.url.split("?")[0]}`);
    return reply.send(await fn(a, req));
  };

  app.get("/healthz", async () => ({ status: "ok" }));

  // USSD gateway webhook (Africa's Talking format): authenticated, validated and rate limited. See ussd-guard.ts.
  registerUssd(app, ctx, opts.ussd ?? {});

  // Ward agent
  app.post("/agent/activate", guarded("member.activate", (a, req) => members.activateMember(ctx, a, req.body).then(() => ({ ok: true }))));

  // Admin
  app.post("/admin/contests", guarded("contest.create", async (_a, req) => ({ id: await contests.createContest(ctx, { ...req.body, voteDate: new Date(req.body.voteDate) }) })));
  app.post("/admin/contests/:id/notice", guarded("notice.generate", (_a, req) => contests.generateNotice(ctx, req.params.id)));
  app.post("/admin/contests/:id/notice-receipt", guarded("receipt.record", (_a, req) => contests.recordNoticeReceipt(ctx, req.params.id, req.body.receipt).then(() => ({ ok: true }))));
  app.post("/admin/registers/:id/receipt", guarded("receipt.record", (_a, req) => contests.recordRegisterReceipt(ctx, req.params.id, req.body.receipt).then(() => ({ ok: true }))));
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
