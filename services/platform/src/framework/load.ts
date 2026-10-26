import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { canonical, sha256hex } from "../crypto.js";
import { resolveModules } from "./modules.js";
import type { Floor, FloorRule, LawPack, Op, PackRule, PartyFile, RuleExpr, Value } from "./types.js";

export class PackError extends Error {}

const EXPR = /^\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*(>=|<=|==|in|has)\s+(.+?)\s*$/;

/** `finance.cap_per_donor_minor <= 50000000000` -> {param, op, value}. The right side is read as YAML. */
export function parseExpr(text: string): RuleExpr {
  const m = EXPR.exec(text);
  if (!m) throw new PackError(`cannot read rule expression: "${text}"`);
  let value: Value;
  try {
    value = YAML.parse(m[3]) as Value;
  } catch {
    throw new PackError(`cannot read the value in: "${text}"`);
  }
  const op = m[2] as Op;
  if ((op === ">=" || op === "<=") && typeof value !== "number") throw new PackError(`${op} needs a number: "${text}"`);
  if ((op === "in" || op === "has") && !Array.isArray(value)) throw new PackError(`${op} needs a list: "${text}"`);
  return { param: m[1], op, value };
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new PackError(msg);
};
const str = (v: unknown, what: string): string => {
  need(typeof v === "string" && v.trim() !== "", `${what} must be a non-empty string`);
  return v as string;
};

/** Walk up from this file until a directory holding floor/floor-v1.yaml is found. OPENPARTY_ROOT overrides. */
export function findRoot(): string {
  if (process.env.OPENPARTY_ROOT) return resolve(process.env.OPENPARTY_ROOT);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "floor", "floor-v1.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new PackError("cannot find the OpenParty root (floor/floor-v1.yaml). Set OPENPARTY_ROOT.");
}

const read = (path: string) => {
  if (!existsSync(path)) throw new PackError(`file not found: ${path}`);
  return readFileSync(path, "utf8");
};

export function loadFloor(path = join(findRoot(), "floor", "floor-v1.yaml")): Floor {
  const doc = YAML.parse(read(path));
  need(doc && Array.isArray(doc.rules), "floor: rules missing");
  const ids = new Set<string>();
  const rules: FloorRule[] = doc.rules.map((r: any) => {
    const id = str(r.id, "floor rule id");
    need(!ids.has(id), `floor: duplicate rule ${id}`);
    ids.add(id);
    need(["enforced", "partial", "not_built"].includes(r.status), `floor ${id}: status must be enforced, partial or not_built`);
    if (r.status !== "enforced") need(r.gap, `floor ${id}: a ${r.status} rule must say what the gap is`);
    return { id, title: str(r.title, `${id} title`), enforces: str(r.enforces, `${id} enforces`), grounds: str(r.grounds, `${id} grounds`),
      status: r.status, gap: r.gap, note: r.note, tests: r.tests, check: r.check };
  });
  return { id: str(doc.id, "floor id"), version: str(doc.version, "floor version"), rules, hash: sha256hex(canonical(doc)) };
}

/** Optional detached ed25519 signature: <pack>.sig holds hex over the pack hash; FOUNDATION_PUBKEY is the raw 32-byte key in hex. */
export function checkSignature(hash: string, sigPath: string, pubHex = process.env.FOUNDATION_PUBKEY): LawPack["signature"] {
  if (!existsSync(sigPath)) return "unsigned";
  if (!pubHex) return "invalid";
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(hash), key, Buffer.from(readFileSync(sigPath, "utf8").trim(), "hex")) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

export function loadPack(path = join(findRoot(), "packs", "ng", "v1", "pack.yaml"), floor?: Floor): LawPack {
  const doc = YAML.parse(read(path));
  need(doc && typeof doc === "object", "pack: not a YAML mapping");
  const id = str(doc.id, "pack id");
  need(doc.params && typeof doc.params === "object", `${id}: params missing`);
  need(Array.isArray(doc.rules) && doc.rules.length > 0, `${id}: rules missing`);
  const cur = doc.currency ?? {};
  need(typeof cur.code === "string" && typeof cur.symbol === "string" && typeof cur.minor_unit === "string" && Number.isInteger(cur.minor_per_unit) && cur.minor_per_unit > 0,
    `${id}: currency needs code, symbol, minor_unit and minor_per_unit`);

  const seen = new Set<string>();
  const rules: PackRule[] = doc.rules.map((r: any) => {
    const rid = str(r.id, "rule id");
    need(!seen.has(rid), `${id}: duplicate rule id ${rid}`);
    seen.add(rid);
    const source = str(r.source, `${rid} source (every rule must cite its law)`);
    const floorRef = str(r.floor, `${rid} floor`);
    if (floor) need(floor.rules.some((f) => f.id === floorRef), `${rid}: floor rule ${floorRef} does not exist`);
    const raw = r.rule === undefined ? [] : Array.isArray(r.rule) ? r.rule : [r.rule];
    const exprs = raw.map((t: unknown) => parseExpr(String(t)));
    need(exprs.length > 0 || r.check === "attest", `${rid}: needs a rule expression or check: attest`);
    for (const e of exprs) need(e.param in doc.params, `${rid}: parameter ${e.param} is not declared in params`);
    return { id: rid, title: str(r.title, `${rid} title`), exprs, check: r.check, attest: r.attest, effect: str(r.effect, `${rid} effect`), source, floor: floorRef, status: str(r.status, `${rid} status`) };
  });

  const featuresOff = (doc.features_off ?? []).map((f: any) => {
    need(f.key in doc.params, `${id}: features_off ${f.key} is not a declared param`);
    return { key: str(f.key, "features_off key"), effect: str(f.effect, "features_off effect"), source: str(f.source, "features_off source") };
  });

  const pack: LawPack = {
    id, version: str(String(doc.version), "pack version"), name: str(doc.name, "pack name"), status: str(doc.status, "pack status"),
    country: str(doc.country, "pack country"), regulator: str(doc.regulator, "pack regulator"), currency: cur, defaultLocale: doc.default_locale ?? "en",
    params: doc.params, featuresOff, rules, hash: sha256hex(canonical(doc)), signature: checkSignature(sha256hex(canonical(doc)), `${path}.sig`),
  };
  return pack;
}

export function loadParty(path = join(findRoot(), "parties", "ddpn", "settings.yaml")): PartyFile {
  const doc = YAML.parse(read(path));
  need(doc && typeof doc === "object", "party: not a YAML mapping");
  return {
    party: str(doc.party, "party"),
    pack: { id: str(doc.pack?.id, "party pack id"), version: str(String(doc.pack?.version), "party pack version") },
    settings: doc.settings ?? {},
    profile: doc.profile ?? {},
    modules: resolveModules(doc.modules),
    hash: sha256hex(canonical(doc)),
  };
}
