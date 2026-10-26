import { canonical, sha256hex } from "../crypto.js";
import { loadFloor, loadPack, loadParty, PackError } from "./load.js";
import { resolveModules } from "./modules.js";
import { effectiveParams, validateConfig } from "./resolve.js";
import type { Config, Floor, LawPack, PartyFile, Value } from "./types.js";

export class ConfigError extends Error {
  constructor(readonly violations: { rule: string; message: string }[]) {
    super(`configuration breaks the law pack:\n${violations.map((v) => `  [${v.rule}] ${v.message}`).join("\n")}`);
  }
}

/** sha256 over the floor version, the pack identity and hash, and the party's settings and profile. */
export function fingerprintOf(floor: Floor, pack: LawPack, party: PartyFile): string {
  return sha256hex(canonical({
    floor: { version: floor.version, hash: floor.hash },
    pack: { id: pack.id, version: pack.version, hash: pack.hash },
    party: { name: party.party, hash: party.hash },
  }));
}

/**
 * Join the three layers into one effective configuration. Throws if the party's settings loosen the law,
 * unless `lenient` is set (used to show a failing configuration in the compliance report).
 */
export function buildConfig(floor: Floor, pack: LawPack, party: PartyFile, opts: { lenient?: boolean } = {}): Config {
  if (party.pack.id !== pack.id)
    throw new PackError(`party ${party.party} is written for pack ${party.pack.id}, not ${pack.id}`);
  const modules = resolveModules(party.modules); // refuses a combination that cannot run, e.g. secret_ballot without voting
  const violations = validateConfig(pack, party.settings);
  if (violations.length && !opts.lenient) throw new ConfigError(violations);
  const params = effectiveParams(pack, party.settings);
  if (!("party.name" in party.settings) && typeof party.profile?.name === "string") params["party.name"] = party.profile.name;
  return {
    floor, pack, party, params, violations, modules,
    fingerprint: fingerprintOf(floor, pack, party),
    get: <T = Value>(key: string) => {
      if (!(key in params)) throw new Error(`unknown configuration key: ${key}`);
      return params[key] as T;
    },
  };
}

let cached: Config | undefined;

/** The bundled reference configuration (floor v1 + NG pack + DDPN), or the paths in PACK_PATH / PARTY_PATH. */
export function loadDefaultConfig(): Config {
  const key = `${process.env.PACK_PATH ?? ""}|${process.env.PARTY_PATH ?? ""}`;
  if (cached && (cached as any)._key === key) return cached;
  const floor = loadFloor();
  const pack = loadPack(process.env.PACK_PATH, floor);
  const party = loadParty(process.env.PARTY_PATH);
  const cfg = buildConfig(floor, pack, party);
  (cfg as any)._key = key;
  return (cached = cfg);
}
