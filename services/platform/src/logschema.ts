// Allowlist for the public log. An event may be written only if its type is listed here and its data has exactly the
// listed fields, each matching a strict shape. Free text, nested objects and serialized JSON never fit a shape, so
// personal data cannot ride along inside a permitted field. Adding an event type means adding a line here (and, for any
// new field, choosing the narrowest kind that fits).

const KINDS = {
  /** Random record id (UUID v4 text). */
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /** SHA-256 or similar, lowercase hex. */
  hash: /^[0-9a-f]{64}$/,
  /** Pseudonymous reference from `logRef`: a keyed hash truncated to 24 hex characters. */
  ref: /^[0-9a-f]{24}$/,
  /** UTC timestamp from `toISOString()`. */
  iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  /** Machine word such as `direct`, `foreign_funds`, `rule.set`, `ward_agent`. */
  token: /^[a-z][a-z0-9_.-]{0,63}$/,
  /** Short code such as a law pack id (`NG`). */
  code: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  /** Version label such as `1.0`. */
  version: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/,
  /** Ward or district name set by an agent: short, plain characters only. */
  label: /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,39}$/,
  /** `METHOD /path` of an admin call (query string already removed). */
  route: /^[A-Z]{3,7} \/[A-Za-z0-9/_.:-]{0,119}$/,
} as const;

type Kind = keyof typeof KINDS | "int";

/** Kinds that carry readable text, where an identifier or phone number could be typed in. */
const TEXTUAL = new Set<Kind>(["token", "code", "version", "label", "route"]);
/** Seven digits in a row is more than any ward number or version needs, and less than any NIN or phone number. */
const LONG_DIGITS = /\d{7,}|(\d[\s-]?){9,}/;

const EVENTS: Record<string, Record<string, Kind>> = {
  "finance.quarantined": { reason: "token", amount_minor: "int" },
  "finance.dues": { ledger_id: "int", amount_minor: "int", member_ref: "ref" },
  "finance.gift": { ledger_id: "int", amount_minor: "int" },
  "rule.set": { key: "token", version: "int", value_hash: "hash", set_by: "uuid" },
  "contest.created": { contest_id: "uuid", mode: "token", vote_date: "iso" },
  "contest.type_changed": { contest_id: "uuid", primary_type: "token" },
  "contest.noticed": { contest_id: "uuid", mode: "token", rules_hash: "hash", vote_date: "iso" },
  "contest.notice_receipt": { contest_id: "uuid", receipt_hash: "hash" },
  "register.frozen": { contest_id: "uuid", register_id: "uuid", fingerprint: "hash", member_count: "int" },
  "register.receipt": { register_id: "uuid", receipt_hash: "hash" },
  "contest.opened": { contest_id: "uuid" },
  "contest.closed": { contest_id: "uuid" },
  "proposal.created": { proposal_id: "uuid", threshold: "int", author_ref: "ref" },
  "proposal.threshold_reached": { proposal_id: "uuid", signatures: "int" },
  "admin.registered": { admin_id: "uuid", role: "token" },
  "admin.access": { admin_id: "uuid", action: "route", detail_hash: "hash" },
  "approval.proposed": { approval_id: "uuid", action: "token", proposer: "uuid" },
  "approval.voted": { approval_id: "uuid", admin_id: "uuid", votes: "int" },
  "approval.executed": { approval_id: "uuid", action: "token" },
  "member.joined": { member_ref: "ref" },
  "member.activated": { member_ref: "ref", agent_id: "uuid", ward: "label" },
  "member.resigned": { member_ref: "ref" },
  "member.erased": { member_ref: "ref" },
  "deployment.configured": {
    fingerprint: "hash", floor_version: "version", pack_id: "code", pack_version: "version", pack_status: "token", pack_signature: "token",
  },
};

function fits(kind: Kind, v: unknown): boolean {
  if (kind === "int") return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (typeof v !== "string") return false;
  if (!KINDS[kind].test(v)) return false;
  return !(TEXTUAL.has(kind) && LONG_DIGITS.test(v));
}

/** Throws unless the event is a listed type with exactly its listed fields, every value in its permitted shape. */
export function assertLoggable(e: { type: string; data: unknown }): void {
  const spec = Object.hasOwn(EVENTS, e.type) ? EVENTS[e.type] : undefined;
  if (!spec) throw new Error(`event type "${String(e.type).slice(0, 40)}" is not on the public-log allowlist`);
  const d = e.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${e.type}: data must be a flat object`);
  const keys = Object.keys(d);
  for (const k of keys) if (!Object.hasOwn(spec, k)) throw new Error(`${e.type}: field "${k.slice(0, 40)}" is not allowed on the public log`);
  for (const [k, kind] of Object.entries(spec)) {
    if (!Object.hasOwn(d, k)) throw new Error(`${e.type}: field "${k}" is missing`);
    // The value itself is never put in the message: it may be exactly the thing that must not be repeated.
    if (!fits(kind, (d as Record<string, unknown>)[k])) throw new Error(`${e.type}: field "${k}" does not match its required shape (${kind})`);
  }
}

/** Event types the log accepts, for docs and tests. */
export const loggableTypes = Object.keys(EVENTS);
