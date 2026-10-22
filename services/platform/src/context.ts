import type { Db } from "./db.js";
import type { KeyStore } from "./crypto.js";
import type { IdAdapter, IdResult, Sms, TrustLog, Payments } from "./adapters.js";
import type { Config } from "./framework/types.js";
import { sha256hex } from "./crypto.js";

export interface PendingJoin {
  subjectId: string;
  result: IdResult;
  expires: number;
}

export interface Ctx {
  db: Db;
  keys: KeyStore;
  /** The three layers joined: international floor, country law pack, party settings. Read every legal number from here. */
  config: Config;
  idAdapter: IdAdapter;
  sms: Sms;
  payments: Payments;
  log: TrustLog;
  /** Injected so legal deadlines can be tested. */
  clock: () => Date;
  pending: Map<string, PendingJoin>;
}

export const DAY = 86_400_000;

/** Pseudonymous reference for the public log: stable per subject, reveals nothing on its own. */
export const logRef = (ctx: Ctx, kind: string, id: string) => ctx.keys.lookupHash(`ref:${kind}`, id).slice(0, 24);
export { sha256hex };
