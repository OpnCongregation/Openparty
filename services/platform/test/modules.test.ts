import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryTrustLog } from "../src/adapters.js";
import { buildConfig, loadDefaultConfig } from "../src/framework/config.js";
import { loadParty } from "../src/framework/load.js";
import { resolveModules } from "../src/framework/modules.js";
import { jobsFor, type Job } from "../src/jobs.js";
import { createCtx } from "../src/platform.js";
import { buildServer } from "../src/server.js";

const base = loadDefaultConfig();
const withModules = (modules: Record<string, boolean>) => buildConfig(base.floor, base.pack, { ...base.party, modules: resolveModules(modules), hash: JSON.stringify(modules) });
const serverWith = async (modules: Record<string, boolean>) => {
  const ctx = await createCtx({ log: new MemoryTrustLog(), config: withModules(modules) });
  return { ctx, app: buildServer(ctx, { ussd: { sim: true } }) };
};

const ID = "00000000-0000-4000-8000-000000000000";
type Route = { module: string; method: "GET" | "POST"; url: string };
// A few routes per module. Each is only checked for "404 or not": a missing route is 404, a present one answers something else (400, 401 ...).
const ROUTES: Route[] = [
  { module: "finance", method: "GET", url: "/admin/finance/donors" },
  { module: "finance", method: "POST", url: "/admin/finance/retry-payments" },
  { module: "finance", method: "POST", url: "/admin/gifts" },
  { module: "petitions", method: "GET", url: `/public/proposals/${ID}` },
  { module: "ussd", method: "POST", url: "/ussd/sim" },
  { module: "voting", method: "GET", url: `/public/election/${ID}` },
  { module: "voting", method: "GET", url: `/public/election/${ID}/results` },
  { module: "voting", method: "POST", url: "/election/apply" },
  { module: "voting", method: "POST", url: "/admin/races" },
  { module: "voting", method: "POST", url: "/agent/vote" },
  { module: "secret_ballot", method: "POST", url: "/election/cast" },
  { module: "secret_ballot", method: "GET", url: `/public/election/${ID}/verify` },
  { module: "secret_ballot", method: "GET", url: `/guardian/ceremony/${ID}` },
  { module: "secret_ballot", method: "POST", url: `/admin/contests/${ID}/tally` },
];
const CORE: [string, string][] = [["GET", "/healthz"], ["GET", "/public/modules"], ["GET", "/framework"], ["GET", "/public/contests"], ["POST", "/admin/approvals"], ["POST", "/agent/activate"]];

// "Route GET:/x not found" is the framework answering for a route that was never registered. A registered route can also say 404
// (for example a proposal that does not exist), with its own error body, so the two are told apart by that message.
const status = async (app: Awaited<ReturnType<typeof serverWith>>["app"], method: string, url: string) => {
  const res = await app.inject({ method: method as "GET" | "POST", url, payload: method === "POST" ? {} : undefined });
  return res.statusCode === 404 && String(res.json().message).startsWith("Route ") ? 404 : res.statusCode === 404 ? "registered" : res.statusCode;
};

describe("modules: a module that is off has no routes", () => {
  it("the DDPN settings turn every module on, and every module's routes exist", async () => {
    expect(base.modules).toEqual({ finance: true, petitions: true, ussd: true, voting: true, secret_ballot: true });
    const { app } = await serverWith(base.modules);
    for (const r of ROUTES) expect(await status(app, r.method, r.url), `${r.method} ${r.url}`).not.toBe(404);
  });

  it.each(["finance", "petitions", "ussd", "voting"])("with %s off, only its routes answer 404", async (off) => {
    // secret_ballot cannot run without voting, so turning voting off turns it off too
    const modules = { ...base.modules, [off]: false, ...(off === "voting" ? { secret_ballot: false } : {}) };
    const { app } = await serverWith(modules);
    const goneModules = off === "voting" ? ["voting", "secret_ballot"] : [off];
    for (const r of ROUTES) expect((await status(app, r.method, r.url)) === 404, `${r.method} ${r.url}`).toBe(goneModules.includes(r.module));
    for (const [m, u] of CORE) expect(await status(app, m, u), `${m} ${u}`).not.toBe(404);
  });

  it("secret_ballot off removes only the secret-ballot routes; plain voting stays", async () => {
    const { app } = await serverWith({ ...base.modules, secret_ballot: false });
    for (const r of ROUTES) expect((await status(app, r.method, r.url)) === 404, `${r.method} ${r.url}`).toBe(r.module === "secret_ballot");
  });

  it("with every module off all optional routes are gone and the core stays", async () => {
    const { app } = await serverWith({});
    for (const r of ROUTES) expect(await status(app, r.method, r.url), `${r.method} ${r.url}`).toBe(404);
    for (const [m, u] of CORE) expect(await status(app, m, u), `${m} ${u}`).not.toBe(404);
  });

  it("/public/modules tells the portal what is on", async () => {
    const { app } = await serverWith({ finance: true, voting: true });
    const body = (await app.inject({ method: "GET", url: "/public/modules" })).json();
    expect(body.modules).toEqual({ finance: true, petitions: false, ussd: false, voting: true, secret_ballot: false });
    expect(body.core).toEqual(["membership", "trust_log", "approvals", "law_pack_checks"]);
  });
});

describe("modules: background jobs follow the modules", () => {
  it("a job of an optional module only runs while it is on; core jobs always run", async () => {
    const run = async () => {};
    const jobs: Job[] = [
      { name: "core", module: null, everySeconds: 1, run },
      { name: "payments", module: "finance", everySeconds: 1, run },
      { name: "tally", module: "secret_ballot", everySeconds: 1, run },
    ];
    const on = await createCtx({ log: new MemoryTrustLog(), config: withModules({ finance: true, voting: true, secret_ballot: true }) });
    const off = await createCtx({ log: new MemoryTrustLog(), config: withModules({ voting: true }) });
    expect(jobsFor(on, jobs).map((j) => j.name)).toEqual(["core", "payments", "tally"]);
    expect(jobsFor(off, jobs).map((j) => j.name)).toEqual(["core"]);
  });
});

describe("modules: the settings are checked at start", () => {
  const partyWith = (modulesYaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), "op-modules-"));
    const file = join(dir, "settings.yaml");
    const src = readFileSync(join(process.cwd(), "..", "..", "parties", "ddpn", "settings.yaml"), "utf8");
    const out = src.replace(/\nmodules:[\s\S]*?\n\nprofile:/, `\n${modulesYaml}\n\nprofile:`);
    expect(out).not.toBe(src);
    writeFileSync(file, out);
    return file;
  };

  it("secret_ballot without voting refuses to start", async () => {
    const file = partyWith("modules:\n  voting: false\n  secret_ballot: true");
    expect(() => loadParty(file)).toThrow(/secret_ballot needs voting/);
    // the start path: main.ts reads the default configuration, and createCtx builds on it
    vi.stubEnv("PARTY_PATH", file);
    try {
      expect(() => loadDefaultConfig()).toThrow(/secret_ballot needs voting/);
      await expect(createCtx({ log: new MemoryTrustLog() })).rejects.toThrow(/secret_ballot needs voting/);
    } finally { vi.unstubAllEnvs(); }
    // and a configuration put together in code is held to the same rule
    expect(() => buildConfig(base.floor, base.pack, { ...base.party, modules: { ...base.modules, voting: false } })).toThrow(/secret_ballot needs voting/);
  });

  it("secret_ballot with voting on starts", () => {
    expect(loadParty(partyWith("modules:\n  voting: true\n  secret_ballot: true")).modules).toMatchObject({ voting: true, secret_ballot: true, finance: false });
  });

  it("core parts cannot be listed, unknown names and non-booleans are refused", () => {
    expect(() => resolveModules({ membership: false })).toThrow(/membership is core/);
    expect(() => resolveModules({ trust_log: true })).toThrow(/trust_log is core/);
    expect(() => resolveModules({ approvals: false })).toThrow(/approvals is core/);
    expect(() => resolveModules({ law_pack_checks: false })).toThrow(/law_pack_checks is core/);
    expect(() => resolveModules({ votng: true })).toThrow(/unknown module "votng"/);
    expect(() => resolveModules({ voting: "yes" })).toThrow(/must be true or false/);
    expect(() => resolveModules(["voting"])).toThrow(/name: true\/false/);
  });

  it("a missing section means every optional module is off", () => {
    expect(resolveModules(undefined)).toEqual({ finance: false, petitions: false, ussd: false, voting: false, secret_ballot: false });
  });
});
