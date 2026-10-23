import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "./context.js";
import { handleUssd } from "./ussd.js";
import { LayeredLimiter, MemoryLimiter, PgLimiter, type Limiter } from "./ratelimit.js";

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
  /** Failed authentications per address per window (also the simulator route's per-address limit). */
  perIp?: number;
  /** Authenticated gateway requests per address per window: a ceiling against a runaway client, not the user-level throttle. */
  perGateway?: number;
  perPhone?: number;
  windowMs?: number;
  /** false = keep counts in this process only (single instance, no database round trip). Default: shared through the database. */
  shared?: boolean;
}

const PHONE = /^\+?[1-9]\d{7,14}$/;
const TEXT = /^[0-9*#]{0,200}$/;
const SESSION = /^[A-Za-z0-9._-]{1,128}$/;

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
  // Counts are shared through the database (all instances, across restarts); a local layer sits in front of it.
  const make = (scope: string, max: number, durable = false): Limiter => {
    const local = new MemoryLimiter(max, windowMs);
    return o.shared === false ? local : new LayeredLimiter(local, new PgLimiter(ctx.db, scope, max, windowMs, Date.now, { durable }));
  };
  // Real traffic arrives from the aggregator's few addresses, so a per-address limit cannot be the main throttle for it: that
  // would cap the whole country. Per address we limit (a) FAILED authentication, which is what stops secret guessing, (b) the
  // unauthenticated simulator route, and (c) the gateway at a high ceiling that only a runaway client would reach. The real
  // per-user control is per phone number.
  // Which counters may reset when the database crashes: only volume throttles (phone, gateway, simulator). Failed authentication is
  // what stops secret guessing, so it is kept in a crash-durable table; PIN guesses are tracked per account in pin_attempts (members.ts).
  const failLimit = make("ussd-authfail", o.perIp ?? 20, true);
  const simLimit = make("ussd-sim", o.perIp ?? 120);
  const gatewayLimit = make("ussd-gateway", o.perGateway ?? 6000);
  const phoneLimit = make("ussd-phone", o.perPhone ?? 30);
  // An empty list means "no allowlist", not "nobody": an unset environment variable must not lock the gateway out.
  const ips = o.allowedIps?.length ? o.allowedIps.map((x) => x.replace(/^::ffff:/, "")) : undefined;

  const tooMany = (reply: FastifyReply) => reply.code(429).header("Retry-After", Math.ceil(windowMs / 1000)).send({ error: "rate_limited" });

  const throttleSim = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await simLimit.take(req.ip))) return tooMany(reply);
  };
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const wrongPlace = ips && !ips.includes(req.ip.replace(/^::ffff:/, ""));
    if (wrongPlace || !sameSecret(presentedSecret(req), o.secret!)) {
      if (!(await failLimit.take(req.ip))) return tooMany(reply); // too many wrong attempts from this address
      return wrongPlace ? reply.code(403).send({ error: "forbidden" }) : reply.code(401).send({ error: "unauthorized" });
    }
    if (!(await gatewayLimit.take(req.ip))) return tooMany(reply);
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const phone = b.phoneNumber;
    const text = b.text ?? "";
    const session = b.sessionId;
    if (typeof phone !== "string" || !PHONE.test(phone) || typeof text !== "string" || !TEXT.test(text)
      || (session !== undefined && (typeof session !== "string" || !SESSION.test(session))))
      return reply.code(400).send({ error: "bad_request" });
    if (!(await phoneLimit.take(phone))) return tooMany(reply);
    reply.type("text/plain");
    return handleUssd(ctx, phone, text, typeof session === "string" ? session : undefined);
  };

  if (o.secret) app.post("/ussd", { onRequest: [authenticate] }, handler);
  if (o.sim) app.post("/ussd/sim", { onRequest: [throttleSim] }, handler);
}
