import type { Db } from "./db.js";
import type { Outbox } from "./outbox.js";
import type { KeyStore } from "./crypto.js";
import type { IdAdapter, IdResult, Sms, TrustLog, Payments } from "./adapters.js";
import type { Config } from "./framework/types.js";
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
  /** Injected so legal deadlines can be tested. */
  clock: () => Date;
}

export const DAY = 86_400_000;

/** Pseudonymous reference for the public log: stable per subject, reveals nothing on its own. */
export const logRef = (ctx: Ctx, kind: string, id: string) => ctx.keys.lookupHash(`ref:${kind}`, id).slice(0, 24);
export { sha256hex };
