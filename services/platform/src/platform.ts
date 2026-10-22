import { randomBytes } from "node:crypto";
import { openDb } from "./db.js";
import { KeyStore } from "./crypto.js";
import type { Ctx } from "./context.js";
import { MemoryTrustLog, SimNgNinAdapter, SimPayments, SimSms, type IdAdapter, type Payments, type Sms, type TrustLog } from "./adapters.js";
import { buildConfig, loadDefaultConfig } from "./framework/config.js";
import type { Config } from "./framework/types.js";

export interface PlatformOptions {
  databaseUrl?: string;
  masterKeyHex?: string;
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
  const db = await openDb(o.databaseUrl);
  const key = (hex: string | undefined) => (hex ? Buffer.from(hex, "hex") : randomBytes(32));
  return {
    db,
    keys: new KeyStore(db, key(o.masterKeyHex), key(o.pepperHex)),
    config,
    idAdapter,
    sms: o.sms ?? new SimSms(),
    payments: o.payments ?? new SimPayments(config.pack.currency.code, config.pack.country),
    log: o.log ?? new MemoryTrustLog(),
    clock: o.clock ?? (() => new Date()),
    pending: new Map(),
  };
}

export { buildConfig };
