import type { Db } from "./db.js";
import type { Outbox } from "./outbox.js";
import type { KeyStore } from "./crypto.js";
import type { IdAdapter, IdResult, Sms, TrustLog, Payments } from "./adapters.js";
import type { Config } from "./framework/types.js";
import type { EgClient } from "./eg-client.js";
import { sha256hex } from "./crypto.js";

export interface Ctx {
  db: Db;
  keys: KeyStore;
  /** The three layers joined: international floor, country law pack, party settings. Read every legal number from here. */
  config: Config;
  idAdapter: IdAdapter;
  sms: Sms;
  payments: Payments;
  /** The public log itself (the sink). Domain code does not call it directly: it queues events with `events.emit` inside `commit`. */
  log: TrustLog;
  /** Transactional outbox in front of the log. */
  events: Outbox;
  /**
   * Run `fn` in one database transaction. Write the change and call `ctx.events.emit(tx, ...)` inside it: the event is
   * committed with the change or not at all. After commit the outbox is flushed so the event reaches the log promptly;
   * if that fails the background publisher retries, and nothing is lost.
   */
  commit<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  /** The ElectionGuard service (the secret ballot). Absent when it is not configured: elections then use the plain ballot box (docs/voting.md). */
  eg?: EgClient;
  /** Injected so legal deadlines can be tested. */
  clock: () => Date;
  /** Test-only fault hook: called at named points where a crash would be interesting; a test makes it throw. Never set in production. */
  crashAt?: (point: string) => void | Promise<void>;
}

/**
 * A context whose database work all happens in ONE transaction: reads and writes go through 	x, commit joins that
 * transaction instead of opening another, and key operations use it too. Used to run an action and its bookkeeping atomically.
 */
export function scopedCtx(ctx: Ctx, tx: Db): Ctx {
  return { ...ctx, db: tx, keys: ctx.keys.forDb(tx), commit: async (fn) => fn(tx) };
}

export const DAY = 86_400_000;

/** Pseudonymous reference for the public log: stable per subject, reveals nothing on its own. */
export const logRef = (ctx: Ctx, kind: string, id: string) => ctx.keys.refHash(`ref:${kind}`, id).slice(0, 24);
export { sha256hex };
