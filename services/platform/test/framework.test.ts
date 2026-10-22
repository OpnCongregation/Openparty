import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildConfig, ConfigError, loadDefaultConfig } from "../src/framework/config.js";
import { assess, ENFORCED_BY } from "../src/framework/compliance.js";
import { findRoot, loadFloor, loadPack, loadParty, parseExpr, PackError } from "../src/framework/load.js";
import { checkSetting, checkValue, satisfies, PARTY_KEYS } from "../src/framework/resolve.js";

const caps = { roles: ["secretary", "electoral_committee", "treasurer", "auditor", "tribunal", "ward_agent"], hasResign: true, uniqueIdPerMember: true };

describe("bundled layers load", () => {
  it("floor v1, NG pack and DDPN settings load and agree", () => {
    const c = loadDefaultConfig();
    expect(c.floor.rules.map((r) => r.id)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);
    expect(c.pack.id).toBe("NG");
    expect(c.pack.rules.length).toBeGreaterThanOrEqual(25);
    expect(c.violations).toEqual([]);
    expect(c.get("finance.cap_per_donor_minor")).toBe(1_000_000_000);
    expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it("every pack rule cites a source and a real floor rule", () => {
    const c = loadDefaultConfig();
    for (const r of c.pack.rules) {
      expect(r.source.length).toBeGreaterThan(3);
      expect(c.floor.rules.some((f) => f.id === r.floor)).toBe(true);
    }
  });
  it("ENFORCED_BY only names parameters that exist", () => {
    const c = loadDefaultConfig();
    for (const k of Object.keys(ENFORCED_BY)) expect(k in c.pack.params || k in PARTY_KEYS).toBe(true);
  });
});

describe("expressions", () => {
  it("reads each operator", () => {
    expect(parseExpr("a.b >= 21")).toEqual({ param: "a.b", op: ">=", value: 21 });
    expect(parseExpr("a.b in [x, y]")).toEqual({ param: "a.b", op: "in", value: ["x", "y"] });
    expect(parseExpr('a.b == "03-30"')).toEqual({ param: "a.b", op: "==", value: "03-30" });
  });
  it("rejects nonsense", () => {
    expect(() => parseExpr("nonsense")).toThrow(PackError);
    expect(() => parseExpr("a.b >= many")).toThrow(/number/);
    expect(() => parseExpr("a.b in 3")).toThrow(/list/);
  });
  it("satisfies: bounds, sets, subsets", () => {
    expect(satisfies(parseExpr("a.b >= 21"), 22)).toBe(true);
    expect(satisfies(parseExpr("a.b >= 21"), 20)).toBe(false);
    expect(satisfies(parseExpr("a.b in [x, y]"), ["x"])).toBe(true);
    expect(satisfies(parseExpr("a.b in [x, y]"), ["x", "z"])).toBe(false);
    expect(satisfies(parseExpr("a.b has [x]"), ["x", "y"])).toBe(true);
    expect(satisfies(parseExpr("a.b == true"), undefined)).toBe(false);
  });
});

describe("tighten, never loosen", () => {
  const c = loadDefaultConfig();
  it("a stricter value is accepted, a looser one is refused with the rule and its citation", () => {
    expect(checkSetting(c.pack, "notice.days_before_contest", 30)).toEqual([]);
    const bad = checkSetting(c.pack, "notice.days_before_contest", 10);
    expect(bad[0].rule).toBe("NG-NOT-01");
    expect(bad[0].source).toMatch(/s\.82\(1\)/);
    expect(checkSetting(c.pack, "finance.cap_per_donor_minor", 1_000_000_000)).toEqual([]);
    expect(checkSetting(c.pack, "finance.cap_per_donor_minor", 50_000_000_001)[0].rule).toBe("NG-FIN-02");
  });
  it("values fixed by law cannot change, and switched-off features stay off", () => {
    expect(checkSetting(c.pack, "finance.anonymous_gifts_allowed", true)[0].rule).toBe("NG-FIN-01");
    expect(checkSetting(c.pack, "eligibility.party_criteria_allowed", true)[0].rule).toBe("NG-ELIG-01");
    expect(checkSetting(c.pack, "safety.security_group_allowed", true)[0].rule).toBe("NG-SAF-01");
  });
  it("a party can narrow a set but not widen it", () => {
    expect(checkSetting(c.pack, "primary.allowed_types", ["direct"])).toEqual([]);
    expect(checkSetting(c.pack, "primary.allowed_types", ["direct", "delegate"])[0].rule).toBe("NG-PRI-01");
    expect(checkSetting(c.pack, "register.fields", ["name"])[0].rule).toBe("NG-REG-02");
  });
  it("unknown settings are refused", () => {
    expect(checkSetting(c.pack, "made.up", 1)[0].rule).toBe("PARTY");
  });
  it("a configuration that loosens the law cannot be built", () => {
    const party = { ...c.party, settings: { ...c.party.settings, "register.days_before_contest": 5 } };
    expect(() => buildConfig(c.floor, c.pack, party)).toThrow(ConfigError);
    const lenient = buildConfig(c.floor, c.pack, party, { lenient: true });
    expect(lenient.violations.map((v) => v.rule)).toContain("NG-REG-01");
  });
  it("checkValue names every rule on a param", () => {
    expect(checkValue(c.pack, "notice.modes", ["virtual", "hybrid"]).map((v) => v.rule)).toEqual(["NG-NOT-01"]);
  });
});

describe("same core, different law pack (synthetic testland)", () => {
  const root = findRoot();
  const floor = loadFloor();
  const tl = loadPack(join(root, "packs", "_test", "testland", "pack.yaml"), floor);
  it("loads and has different values from Nigeria", () => {
    const ng = loadDefaultConfig().pack;
    expect(tl.params["notice.days_before_contest"]).toBe(14);
    expect(ng.params["notice.days_before_contest"]).toBe(21);
    expect(tl.currency.code).toBe("TST");
  });
  it("the Nigerian DDPN settings are refused on the testland pack", () => {
    const party = loadParty();
    expect(() => buildConfig(floor, tl, party)).toThrow(/pack NG, not TL/);
  });
});

describe("compliance report", () => {
  const c = loadDefaultConfig();
  const a = assess(c, caps);
  it("is honest about what is enforced and what is only declared", () => {
    const byId = Object.fromEntries(a.rules.map((r) => [r.id, r]));
    expect(byId["NG-NOT-01"].status).toBe("enforced");
    expect(byId["NG-NOT-02"].status).toBe("declared");
    expect(byId["NG-ORG-04"].status).toBe("needs_attestation");
    expect(byId["NG-FIN-02"].tightensLaw).toBe(true);
    expect(a.summary.declared).toBeGreaterThan(0);
  });
  it("floor checks pass for the reference configuration and name what is missing", () => {
    expect(a.floorBreached).toEqual([]);
    expect(a.floor.find((f) => f.id === "F11")!.check_result!.ok).toBe(true);
    expect(a.floor.find((f) => f.id === "F1")!.status).toBe("not_built");
    expect(a.notice).toMatch(/not a certification/);
  });
  it("floor F11 fails if a security role appears", () => {
    const bad = assess(c, { ...caps, roles: [...caps.roles, "party_security"] });
    expect(bad.floorBreached).toContain("F11");
  });
  it("unsigned packs are reported as unsigned", () => {
    expect(a.layers.pack.signature).toBe("unsigned");
  });
});

describe("signed law packs", () => {
  it("a pack signed with the foundation key verifies, and any edit afterwards is reported invalid", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = findRoot();
    const dir = mkdtempSync(join(tmpdir(), "op-sign-"));
    try {
      const out = execFileSync("node", [join(root, "scripts", "sign-pack.mjs"), "keygen"]).toString();
      const seed = /private seed[^:]*: ([0-9a-f]{64})/.exec(out)![1];
      const pub = /public key[^:]*: ([0-9a-f]{64})/.exec(out)![1];
      const file = join(dir, "pack.yaml");
      copyFileSync(join(root, "packs", "ng", "v1", "pack.yaml"), file);
      execFileSync("node", [join(root, "scripts", "sign-pack.mjs"), "sign", file, seed]);
      process.env.FOUNDATION_PUBKEY = pub;
      expect(loadPack(file, loadFloor()).signature).toBe("valid");
      writeFileSync(file, readFileSync(file, "utf8").replace("N500 million", "N900 million"));
      expect(loadPack(file, loadFloor()).signature).toBe("invalid");
      delete process.env.FOUNDATION_PUBKEY;
      expect(loadPack(file, loadFloor()).signature).toBe("invalid"); // a signature exists but there is no key to check it with
    } finally {
      delete process.env.FOUNDATION_PUBKEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
