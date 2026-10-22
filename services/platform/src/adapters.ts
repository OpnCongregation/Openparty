import { canonical } from "./crypto.js";
import { assertLoggable } from "./logschema.js";

// ---- Identity adapters ------------------------------------------------------------------------
// Every country plugs its own ID system into the core through this one interface. The core learns only whether the
// person is real, unique and eligible; the ID number is used for a keyed one-way hash and, where the law requires it
// on the register, held encrypted in the register only.

/** 1 = low (self-declared), 2 = medium (document or database check), 3 = high (biometric or in person). */
export type Assurance = 1 | 2 | 3;

export interface IdResult {
  verified: true;
  /** Meets the voting age set in the law pack. Date of birth itself stays in `attributes`. */
  ageOk: boolean;
  /** Ward or district, if the ID system provides it. */
  area?: string;
  assurance: Assurance;
  /** First letters of the name, shown back to the person to confirm. */
  preview: string;
  /** Goes ONLY into the member's encrypted register record, never into the core or the public log. */
  attributes: Record<string, string>;
}

export interface IdAdapter {
  /** Stable adapter id that a law pack names, e.g. "ng_nin". */
  readonly id: string;
  /** The assurance this adapter can reach. */
  readonly assurance: Assurance;
  /** Look up the person. Returns null if the id is not valid or not found. Never returns the id number itself. */
  verify(subjectId: string): Promise<IdResult | null>;
}

/** Nigeria reference adapter, simulated: any 11-digit NIN not starting with 0 "verifies"; identity is derived from it. */
export class SimNgNinAdapter implements IdAdapter {
  readonly id = "ng_nin";
  readonly assurance: Assurance = 2;
  async verify(nin: string): Promise<IdResult | null> {
    if (!/^[1-9]\d{10}$/.test(nin)) return null;
    const n = Number(nin.slice(-2));
    const name = `Musa Ibrahim ${nin.slice(-4)}`;
    return {
      verified: true, ageOk: true, area: "Gwale", assurance: this.assurance,
      preview: name.slice(0, 3).toUpperCase() + "…",
      attributes: { name, sex: n % 2 ? "F" : "M", birth_date: "1985-04-12", address: `${n} Market Road`, state: "Kano", lga: "Gwale" },
    };
  }
}

// ---- SMS --------------------------------------------------------------------------------------

export interface Sms {
  send(phone: string, text: string): Promise<void>;
}

export class SimSms implements Sms {
  outbox: { phone: string; text: string }[] = [];
  async send(phone: string, text: string) {
    this.outbox.push({ phone, text });
  }
}

// ---- Payments ---------------------------------------------------------------------------------

export interface IncomingPayment {
  ref: string;
  amountMinor: number;
  currency: string;
  /** ISO country of the paying card/account. */
  country: string;
}

// ---- Trust log --------------------------------------------------------------------------------

export interface LogEvent {
  type: string;
  data: Record<string, unknown>;
  /** When the event was committed (set by the outbox). Defaults to the time of publishing. */
  at?: string;
  /** Idempotency key: the log ignores a second append with the same oid and returns the first index. */
  oid?: string;
}

export interface TrustLog {
  append(e: LogEvent): Promise<{ index: number }>;
}

// No personal data may reach the public log. The real guard is the allowlist in logschema.ts (listed event types, exact
// fields, strict value shapes). This key denylist stays as a second, independent check.
const FORBIDDEN = /(^|_)(name|nin|phone|address|dob|email|photo|sex|pin)($|_)/i;

export function assertNoPersonalData(v: unknown, path = "data"): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoPersonalData(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.test(k.replace(/([a-z])([A-Z])/g, "$1_$2"))) throw new Error(`personal-data key "${k}" not allowed on the public log (${path})`);
      assertNoPersonalData(x, `${path}.${k}`);
    }
  }
}

export function assertPublicLogSafe(e: LogEvent): void {
  assertLoggable(e);
  assertNoPersonalData(e.data);
}

export class HttpTrustLog implements TrustLog {
  constructor(private url: string, private token: string) {}
  async append(e: LogEvent) {
    assertPublicLogSafe(e);
    const body = canonical({ ...e, at: e.at ?? new Date().toISOString() });
    const r = await fetch(`${this.url.replace(/\/$/, "")}/append`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body,
    });
    if (!r.ok) throw new Error(`trustlog append failed: ${r.status}`);
    return { index: ((await r.json()) as { index: number }).index };
  }
}

/** In-process log for tests and local dev without the Go service. */
export class MemoryTrustLog implements TrustLog {
  events: (LogEvent & { index: number })[] = [];
  async append(e: LogEvent) {
    assertPublicLogSafe(e);
    const seen = e.oid ? this.events.find((x) => x.oid === e.oid) : undefined;
    if (seen) return { index: seen.index }; // same idempotency key: already logged
    const index = this.events.length;
    this.events.push({ ...e, index });
    return { index };
  }
}

export interface Payments {
  /**
   * Ask the payment provider to charge the phone's wallet or bank; returns the settled payment.
   * `idempotencyKey` is a contract: calling again with the same key must return the same payment and never charge twice.
   * A real adapter must pass it to the provider's own idempotency mechanism.
   */
  charge(phone: string, amountMinor: number, idempotencyKey?: string): Promise<IncomingPayment>;
}

export class SimPayments implements Payments {
  n = 0;
  private byKey = new Map<string, IncomingPayment>();
  /** Simulated payer: a domestic account in the deployment's own currency unless told otherwise. */
  constructor(private currency = "NGN", private country = "NG") {}
  async charge(_phone: string, amountMinor: number, idempotencyKey?: string): Promise<IncomingPayment> {
    const seen = idempotencyKey ? this.byKey.get(idempotencyKey) : undefined;
    if (seen) return seen;
    const p = { ref: `SIM-${Date.now()}-${++this.n}`, amountMinor, currency: this.currency, country: this.country };
    if (idempotencyKey) this.byKey.set(idempotencyKey, p);
    return p;
  }
}
