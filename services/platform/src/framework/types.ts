export type Value = string | number | boolean | null | Value[];

export type Op = ">=" | "<=" | "==" | "in" | "has";

export interface RuleExpr {
  param: string;
  op: Op;
  value: Value;
}

export interface PackRule {
  id: string;
  title: string;
  exprs: RuleExpr[];
  /** "attest" rules cannot be machine-checked; a human confirms them. */
  check?: "attest";
  attest?: string;
  effect: string;
  source: string;
  floor: string;
  status: string;
}

export interface FeatureOff {
  key: string;
  effect: string;
  source: string;
}

export interface LawPack {
  id: string;
  version: string;
  name: string;
  status: string;
  country: string;
  /** The body parties file with (INEC in Nigeria). Shown to members in plain words. */
  regulator: string;
  currency: { code: string; symbol: string; minor_unit: string; minor_per_unit: number };
  defaultLocale: string;
  params: Record<string, Value>;
  featuresOff: FeatureOff[];
  rules: PackRule[];
  hash: string;
  /** unsigned = no signature file; valid / invalid = checked against FOUNDATION_PUBKEY. */
  signature: "unsigned" | "valid" | "invalid";
}

export interface FloorRule {
  id: string;
  title: string;
  enforces: string;
  grounds: string;
  status: "enforced" | "partial" | "not_built";
  gap?: string;
  note?: string;
  tests?: string[];
  check?: string;
}

export interface Floor {
  id: string;
  version: string;
  rules: FloorRule[];
  hash: string;
}

export interface PartyFile {
  party: string;
  pack: { id: string; version: string };
  settings: Record<string, Value>;
  profile: Record<string, any>;
  hash: string;
}

export interface Violation {
  /** Pack rule id, or "PARTY" / "PACK" for structural problems. */
  rule: string;
  param: string;
  message: string;
  source: string;
}

export interface Config {
  floor: Floor;
  pack: LawPack;
  party: PartyFile;
  /** Pack defaults overlaid with the party's settings. */
  params: Record<string, Value>;
  violations: Violation[];
  fingerprint: string;
  get<T = Value>(key: string): T;
}
