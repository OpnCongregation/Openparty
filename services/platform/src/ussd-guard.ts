import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "./context.js";
import { handleUssd } from "./ussd.js";

// The USSD webhook is the one public write path on the platform, and the phone number in it is the only "identity" a
// feature-phone user has. A gateway request must therefore be proven to come from the gateway before that number is
// believed, and even then the volume of requests per number and per source is limited (a 4-digit PIN is only as strong
// as its attempt counter).

export interface UssdOptions {
  /** Shared secret the gateway sends. Without one the authenticated route is not registered at all (fail closed). */
  secret?: string;
  /** If set, only these source addresses may call the authenticated route. */
  allowedIps?: string[];
  /** Register /ussd/sim, an unauthenticated route for the browser simulator. Demo and lab only. */
  sim?: boolean;
  /** Requests per minute. */
  perIp?: number;
  perPhone?: number;
  windowMs?: number;
}

const PHONE = /^\+?[1-9]\d{7,14}$/;
const TEXT = /^[0-9*#]{0,200}$/;
const SESSION = /^[A-Za-z0-9._-]{1,128}$/;

/** Sliding-window counter held in memory. One platform instance only; a shared store is needed to scale out. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  /** True if this request is allowed (and counts it). */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.sweep(t);
    return true;
  }
  private sweep(t: number) {
    for (const [k, v] of this.hits) if (!v.length || t - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
    // Still huge (a flood of distinct keys): drop everything rather than grow without bound.
    if (this.hits.size > 50_000) this.hits.clear();
  }
}

function sameSecret(got: string | undefined, want: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The secret may arrive as `x-ussd-secret`, or as the password (or the whole credential) of HTTP Basic auth. */
function presentedSecret(req: FastifyRequest): string | undefined {
  const h = req.headers["x-ussd-secret"];
  if (typeof h === "string") return h;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Basic ")) {
    const cred = Buffer.from(auth.slice(6), "base64").toString();
    const i = cred.indexOf(":");
    return i < 0 ? cred : cred.slice(i + 1);
  }
  return undefined;
}

export function registerUssd(app: FastifyInstance, ctx: Ctx, o: UssdOptions) {
  const windowMs = o.windowMs ?? 60_000;
  const ipLimit = new RateLimiter(o.perIp ?? 120, windowMs);
  const phoneLimit = new RateLimiter(o.perPhone ?? 30, windowMs);
  // An empty list means "no allowlist", not "nobody": an unset environment variable must not lock the gateway out.
  const ips = o.allowedIps?.length ? o.allowedIps.map((x) => x.replace(/^::ffff:/, "")) : undefined;

  const tooMany = (reply: FastifyReply) => reply.code(429).header("Retry-After", Math.ceil(windowMs / 1000)).send({ error: "rate_limited" });

  const throttleIp = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ipLimit.take(req.ip)) return tooMany(reply);
  };
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (ips && !ips.includes(req.ip.replace(/^::ffff:/, ""))) return reply.code(403).send({ error: "forbidden" });
    if (!sameSecret(presentedSecret(req), o.secret!)) return reply.code(401).send({ error: "unauthorized" });
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const phone = b.phoneNumber;
    const text = b.text ?? "";
    const session = b.sessionId;
    if (typeof phone !== "string" || !PHONE.test(phone) || typeof text !== "string" || !TEXT.test(text)
      || (session !== undefined && (typeof session !== "string" || !SESSION.test(session))))
      return reply.code(400).send({ error: "bad_request" });
    if (!phoneLimit.take(phone)) return tooMany(reply);
    reply.type("text/plain");
    return handleUssd(ctx, phone, text, typeof session === "string" ? session : undefined);
  };

  if (o.secret) app.post("/ussd", { onRequest: [throttleIp, authenticate] }, handler);
  if (o.sim) app.post("/ussd/sim", { onRequest: [throttleIp] }, handler);
}
