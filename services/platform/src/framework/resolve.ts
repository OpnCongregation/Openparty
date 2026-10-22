import type { LawPack, RuleExpr, Value, Violation } from "./types.js";

const eq = (a: Value, b: Value): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Does `v` satisfy `<param> <op> <value>`? */
export function satisfies(e: RuleExpr, v: Value | undefined): boolean {
  if (v === undefined || v === null) return false;
  switch (e.op) {
    case ">=": return typeof v === "number" && v >= (e.value as number);
    case "<=": return typeof v === "number" && v <= (e.value as number);
    case "==": return eq(v, e.value);
    case "in": {
      const set = e.value as Value[];
      return Array.isArray(v) ? v.length > 0 && v.every((x) => set.some((s) => eq(s, x))) : set.some((s) => eq(s, v));
    }
    case "has": return Array.isArray(v) && (e.value as Value[]).every((x) => v.some((y) => eq(x, y)));
  }
}

const show = (e: RuleExpr) => `${e.param} ${e.op} ${JSON.stringify(e.value)}`;

/** Settings keys that belong to the party alone (no legal bound), with their defaults and checks. */
const int = (min: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min;
const strList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");

export const PARTY_KEYS: Record<string, { default: Value; check: (v: unknown) => boolean; hint: string }> = {
  "dues.min_payment_minor": { default: 10_000, check: int(0), hint: "a whole number of minor currency units, 0 or more" },
  "dues.standard_annual_minor": { default: 120_000, check: int(0), hint: "a whole number of minor units, 0 or more" },
  "dues.reduced_annual_minor": { default: 60_000, check: int(0), hint: "a whole number of minor units, 0 or more" },
  "dues.voting_lapse_months": { default: 6, check: int(1), hint: "a whole number of months, 1 or more" },
  "finance.cap_window_days": { default: null, check: int(1), hint: "a whole number of days, 1 or more (leave unset for a lifetime cap)" },
  "proposals.threshold": { default: 100, check: int(1), hint: "a whole number of signatures, 1 or more" },
  "proposals.response_days": { default: 30, check: int(1), hint: "a whole number of days, 1 or more" },
  "ratings.min_to_show": { default: 1, check: int(1), hint: "a whole number, 1 or more" },
  "ratings.separate_member_public": { default: true, check: (v) => typeof v === "boolean", hint: "true or false" },
  "ratings.effect_on_eligibility": { default: "none", check: (v) => v === "none", hint: "must be none: ratings never decide who may stand" },
  "ratings.constituency": { default: "declared", check: (v) => v === "declared" || v === "verified", hint: "declared or verified" },
  "languages.launch": { default: ["en"], check: strList, hint: "a list of language codes" },
  "languages.second_wave": { default: [], check: (v) => Array.isArray(v), hint: "a list of language codes" },
  "org.max_terms": { default: 2, check: int(1), hint: "a whole number, 1 or more" },
  "org.women_target_pct": { default: 0, check: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100, hint: "a whole number from 0 to 100" },
  "org.chairman_secretary_different_zone": { default: false, check: (v) => typeof v === "boolean", hint: "true or false" },
  "party.name": { default: "OpenParty", check: (v) => typeof v === "string" && v.trim() !== "", hint: "a non-empty name" },
};

/** Settings that can also be changed while the party runs (with approvals), until a contest notice locks them. */
export const EDITABLE_KEYS = [
  "dues.min_payment_minor", "finance.cap_per_donor_minor", "finance.cap_window_days",
  "proposals.threshold", "proposals.response_days", "languages.launch", "party.name",
] as const;

/** Every pack rule that applies to this param, checked against a proposed value. */
export function checkValue(pack: LawPack, param: string, v: Value | undefined): Violation[] {
  const out: Violation[] = [];
  for (const r of pack.rules)
    for (const e of r.exprs)
      if (e.param === param && !satisfies(e, v))
        out.push({ rule: r.id, param, source: r.source,
          message: `${param} = ${JSON.stringify(v)} breaks ${r.id}: requires ${show(e)}. ${r.title}` });
  const off = pack.featuresOff.find((f) => f.key === param);
  if (off && !out.length && JSON.stringify(v) !== JSON.stringify(pack.params[param]))
    out.push({ rule: "FEATURE-OFF", param, source: off.source, message: `${param} is switched off by law and cannot be changed. ${off.effect}` });
  return out;
}

/** Would this one setting be accepted on this pack? Also checks keys the pack does not bound. */
export function checkSetting(pack: LawPack, param: string, v: Value | undefined): Violation[] {
  const party = PARTY_KEYS[param];
  const declared = param in pack.params;
  if (!declared && !party)
    return [{ rule: "PARTY", param, source: "", message: `${param} is not a setting this framework knows` }];
  const out = declared ? checkValue(pack, param, v) : [];
  if (party && v !== undefined && v !== null && !party.check(v))
    out.push({ rule: "PARTY", param, source: "", message: `${param} must be ${party.hint}` });
  return out;
}

/** Pack defaults overlaid with party settings; party-only keys get their defaults. */
export function effectiveParams(pack: LawPack, settings: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = { ...pack.params };
  for (const [k, p] of Object.entries(PARTY_KEYS)) out[k] = p.default;
  return { ...out, ...settings };
}

/** Structural and cross-field checks over a whole configuration. Tighten-only is enforced here. */
export function validateConfig(pack: LawPack, settings: Record<string, Value>): Violation[] {
  const out: Violation[] = [];
  for (const [k, v] of Object.entries(settings)) out.push(...checkSetting(pack, k, v));
  const eff = effectiveParams(pack, settings);
  // The pack's own defaults must obey its own rules (a pack that contradicts itself is a bug in the pack).
  for (const r of pack.rules)
    for (const e of r.exprs)
      if (!(e.param in settings) && !satisfies(e, eff[e.param]))
        out.push({ rule: r.id, param: e.param, source: r.source, message: `pack default ${e.param} = ${JSON.stringify(eff[e.param])} breaks ${r.id}: ${show(e)}` });
  const allowed = eff["primary.allowed_types"];
  if (Array.isArray(allowed) && !allowed.includes(eff["primary.default_type"] as Value))
    out.push({ rule: "PARTY", param: "primary.default_type", source: "", message: "primary.default_type must be one of primary.allowed_types" });
  if ((eff["dues.reduced_annual_minor"] as number) > (eff["dues.standard_annual_minor"] as number))
    out.push({ rule: "PARTY", param: "dues.reduced_annual_minor", source: "", message: "reduced dues cannot exceed standard dues" });
  return out;
}
