import { satisfies } from "./resolve.js";
import type { Config, FloorRule } from "./types.js";

/**
 * Which parameters the running code actually reads, and where. This is what keeps the report honest: a pack rule
 * only counts as "enforced" if the code consults its parameter. Anything else is declared in the pack but waits for
 * a module that is not built yet. Keep this list in step with the code (a test checks it against the pack).
 */
export const ENFORCED_BY: Record<string, string> = {
  "identity.adapter": "platform.createCtx picks the adapter from this setting",
  "identity.min_assurance_join": "members.prepareJoin refuses weaker adapters",
  "identity.id_required": "members.prepareJoin: no join without a verified id",
  "register.fields": "members.missingRegisterFields, contests.freezeRegister",
  "register.days_before_contest": "contests.freezeRegister",
  "register.late_filing_bars_candidates": "contests.freezeRegister snapshots the register at the freeze",
  "card.issued_on_activation": "database CHECK: no active member without a card number",
  "notice.days_before_contest": "contests.generateNotice",
  "notice.mode_required": "contests.createContest",
  "notice.modes": "contests.createContest",
  "primary.allowed_types": "contests.createContest, contests.changePrimaryType",
  "primary.default_type": "contests.createContest",
  "primary.type_lock_days": "contests.changePrimaryType",
  "eligibility.party_criteria_allowed": "contests.setRule has no key that could add aspirant criteria",
  "finance.anonymous_gifts_allowed": "finance.recordGift",
  "finance.donor_fields": "finance.recordGift",
  "finance.cap_per_donor_minor": "finance.recordGift, contests.setRule",
  "finance.foreign_funds_allowed": "finance.rejectForeign",
  "finance.accepted_currency": "finance.rejectForeign",
  "finance.accepted_country": "finance.rejectForeign",
  "safety.security_group_allowed": "admin.ROLES has no security role",
  "org.hq": "framework settings check",
  "org.max_term_years": "framework settings check",
  "org.min_states_in_executive": "framework settings check",
};

export type RuleStatus = "enforced" | "partial" | "declared" | "needs_attestation";

export interface FloorCaps {
  roles: readonly string[];
  hasResign: boolean;
  uniqueIdPerMember: boolean;
}

export interface FloorResult extends FloorRule {
  check_result?: { ok: boolean; detail: string };
}

const PROTECTED = /(sex|gender|relig|ethnic|tribe|tribal|origin|disab)/i;

/** Automated floor checks. They can only prove the absence of a violation, never certify a deployment. */
function runCheck(name: string, cfg: Config, caps: FloorCaps): { ok: boolean; detail: string } {
  switch (name) {
    case "one_person_one_membership":
      return { ok: caps.uniqueIdPerMember, detail: "membership is keyed on a one-way hash of the verified id, which is UNIQUE" };
    case "no_protected_attribute_gates": {
      const gating = Object.keys(cfg.params).filter((k) => /^(eligibility|membership)\./.test(k) && PROTECTED.test(k));
      return { ok: gating.length === 0, detail: gating.length ? `eligibility/membership settings reference protected attributes: ${gating.join(", ")}` : "no eligibility or membership setting references a protected attribute" };
    }
    case "resignation_available":
      return { ok: caps.hasResign, detail: "members.resign is always available" };
    case "no_security_role": {
      const bad = caps.roles.filter((r) => /secur|militia|force|guard/i.test(r));
      return { ok: bad.length === 0, detail: bad.length ? `roles that look like a security role: ${bad.join(", ")}` : `no security role among: ${caps.roles.join(", ")}` };
    }
    case "officer_terms_within_pack": {
      const term = cfg.get<number>("org.max_term_years");
      return { ok: Number.isInteger(term) && term > 0, detail: `officer terms are capped at ${term} years` };
    }
    default:
      return { ok: false, detail: `unknown check ${name}` };
  }
}

export function assess(cfg: Config, caps: FloorCaps) {
  const rules = cfg.pack.rules.map((r) => {
    const params = [...new Set(r.exprs.map((e) => e.param))];
    const enforcedBy = params.filter((p) => p in ENFORCED_BY).map((p) => ({ param: p, by: ENFORCED_BY[p] }));
    const attest = cfg.party.profile?.attestations?.[r.id];
    let status: RuleStatus;
    if (r.check === "attest") status = "needs_attestation";
    else if (enforcedBy.length === params.length) status = "enforced";
    else if (enforcedBy.length > 0) status = "partial";
    else status = "declared";
    const passes = r.exprs.every((e) => satisfies(e, cfg.params[e.param]));
    return {
      id: r.id, title: r.title, source: r.source, floor: r.floor, status, packStatus: r.status, effect: r.effect,
      rules: r.exprs.map((e) => `${e.param} ${e.op} ${JSON.stringify(e.value)}`),
      partyValue: Object.fromEntries(params.map((p) => [p, cfg.params[p]])),
      partyPasses: r.check === "attest" ? null : passes,
      attestation: r.check === "attest" ? { text: r.attest, state: attest ?? "pending" } : undefined,
      enforcedBy,
      tightensLaw: r.exprs.filter((e) => e.op === ">=" || e.op === "<=").some((e) => cfg.params[e.param] !== e.value),
    };
  });

  const floor = cfg.floor.rules.map((f): FloorResult => (f.check ? { ...f, check_result: runCheck(f.check, cfg, caps) } : f));
  const floorBreached = floor.filter((f) => f.check_result && !f.check_result.ok).map((f) => f.id);

  const count = (s: RuleStatus) => rules.filter((r) => r.status === s).length;
  return {
    notice: "Self-assessment by the running code. It is not a certification and not legal advice.",
    fingerprint: cfg.fingerprint,
    layers: {
      floor: { version: cfg.floor.version, hash: cfg.floor.hash },
      pack: { id: cfg.pack.id, name: cfg.pack.name, version: cfg.pack.version, status: cfg.pack.status, hash: cfg.pack.hash, signature: cfg.pack.signature, currency: cfg.pack.currency },
      party: { name: cfg.party.party, hash: cfg.party.hash },
    },
    violations: cfg.violations,
    floorBreached,
    summary: {
      packRules: rules.length, enforced: count("enforced"), partial: count("partial"), declared: count("declared"), needsAttestation: count("needs_attestation"),
      floor: { enforced: floor.filter((f) => f.status === "enforced").length, partial: floor.filter((f) => f.status === "partial").length, notBuilt: floor.filter((f) => f.status === "not_built").length },
    },
    floor,
    rules,
  };
}
