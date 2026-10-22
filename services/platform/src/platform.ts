import { randomBytes } from "node:crypto";
import { openDb } from "./db.js";
import { KeyStore, type KeyProvider } from "./crypto.js";
import type { Ctx } from "./context.js";
import { Outbox } from "./outbox.js";
import { MemoryTrustLog, SimNgNinAdapter, SimPayments, SimSms, type IdAdapter, type Payments, type Sms, type TrustLog } from "./adapters.js";
import { buildConfig, loadDefaultConfig } from "./framework/config.js";
import type { Config } from "./framework/types.js";

export interface PlatformOptions {
  databaseUrl?: string;
  masterKeyHex?: string;
  /** Overrides masterKeyHex: a key ring or an HSM/KMS-backed provider. */
  keyProvider?: KeyProvider;
  pepperHex?: string;
  log?: TrustLog;
  /** Floor + law pack + party settings. Defaults to the bundled reference configuration. */
  config?: Config;
  idAdapter?: IdAdapter;
  sms?: Sms;
  payments?: Payments;
  clock?: () => Date;
}

/** Adapters a deployment may select by the id a law pack names. Real providers register here. */
export const ID_ADAPTERS: Record<string, () => IdAdapter> = {
  ng_nin: () => new SimNgNinAdapter(),
};

/** Assemble a context. Anything not supplied falls back to a local simulator. */
export async function createCtx(o: PlatformOptions = {}): Promise<Ctx> {
  const config = o.config ?? loadDefaultConfig();
  const wanted = String(config.get("identity.adapter"));
  const idAdapter = o.idAdapter ?? ID_ADAPTERS[wanted]?.();
  if (!idAdapter) throw new Error(`identity adapter "${wanted}" is not installed (installed: ${Object.keys(ID_ADAPTERS).join(", ")})`);
  if (idAdapter.id !== wanted) throw new Error(`the configuration asks for identity adapter "${wanted}" but "${idAdapter.id}" was supplied`);
  // Test hook: the suite can run against a real Postgres server (scripts/test-postgres.mjs), each test in its own schema.
  const testUrl = process.env.VITEST ? process.env.OPENPARTY_TEST_DATABASE_URL : undefined;
  const db = o.databaseUrl ? await openDb(o.databaseUrl) : testUrl ? await openDb(testUrl, { schema: `t_${randomBytes(8).toString("hex")}` }) : await openDb();
  const key = (hex: string | undefined) => (hex ? Buffer.from(hex, "hex") : randomBytes(32));
  const log = o.log ?? new MemoryTrustLog();
  const events = new Outbox(db, log);
  return {
    db,
    keys: new KeyStore(db, o.keyProvider ?? key(o.masterKeyHex), key(o.pepperHex)),
    config,
    idAdapter,
    sms: o.sms ?? new SimSms(),
    payments: o.payments ?? new SimPayments(config.pack.currency.code, config.pack.country),
    log,
    events,
    async commit(fn) {
      const r = await db.tx(fn);
      await events.flush(); // best effort: never throws; a failure leaves the event queued for the background publisher
      return r;
    },
    clock: o.clock ?? (() => new Date()),
  };
}

export { buildConfig };
