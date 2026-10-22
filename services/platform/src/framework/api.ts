import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.js";
import { ROLES } from "../admin.js";
import { assess } from "./compliance.js";
import { findRoot } from "./load.js";
import { checkSetting, effectiveParams, PARTY_KEYS } from "./resolve.js";
import type { Value } from "./types.js";

/** What the running code can do, for the floor checks that depend on it. Kept next to the code it describes. */
export const CAPS = (): Parameters<typeof assess>[1] => ({ roles: ROLES, hasResign: true, uniqueIdPerMember: true });

function registry() {
  const f = join(findRoot(), "registry", "deployments.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { deployments: [] };
}

const parseValue = (raw: string): Value => {
  try { return JSON.parse(raw) as Value; } catch { return raw; }
};

/**
 * Read-only, public. The layers, the rules, the party's settings and an honest self-assessment, so anyone can see
 * which law a deployment runs under. GET only (no CORS preflight needed from the portal).
 */
export function registerFramework(app: FastifyInstance, ctx: Ctx) {
  app.get("/framework", async () => {
    const cfg = ctx.config;
    return {
      ...assess(cfg, CAPS()),
      party: { name: cfg.party.party, pack: cfg.party.pack, settings: cfg.party.settings, profile: cfg.party.profile },
      effective: cfg.params,
      packDefaults: cfg.pack.params,
      featuresOff: cfg.pack.featuresOff,
      currency: cfg.pack.currency,
      idAdapter: { id: ctx.idAdapter.id, assurance: ctx.idAdapter.assurance },
      registry: registry(),
    };
  });

  // Would this party setting be accepted on this law pack, and which rule decides? Does not change anything.
  app.get("/framework/check", async (req, reply) => {
    const q = req.query as { param?: string; value?: string };
    if (!q.param) return reply.status(400).send({ error: "param_required", message: "Give ?param=<setting>&value=<json>" });
    const known = q.param in ctx.config.pack.params || q.param in PARTY_KEYS;
    const value = q.value === undefined ? undefined : parseValue(q.value);
    const violations = checkSetting(ctx.config.pack, q.param, value);
    return {
      param: q.param, value, known,
      accepted: violations.length === 0,
      violations,
      packDefault: ctx.config.pack.params[q.param] ?? null,
      currentValue: effectiveParams(ctx.config.pack, ctx.config.party.settings)[q.param] ?? null,
    };
  });
}
