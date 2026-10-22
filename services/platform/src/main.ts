import { createCtx } from "./platform.js";
import { keyProviderFromEnv } from "./crypto.js";
import { buildServer } from "./server.js";
import { HttpTrustLog } from "./adapters.js";
import { registerLab } from "./lab.js";
import { recordDeployment } from "./framework/deploy.js";

const logUrl = process.env.TRUSTLOG_URL;
const keyProvider = keyProviderFromEnv(process.env);
// The only key provider so far holds the master key in this process's memory. That is not an HSM, so a production
// start must say so explicitly instead of looking compliant by accident.
if (process.env.NODE_ENV === "production" && (!keyProvider || keyProvider.software) && process.env.ALLOW_SOFTWARE_KEYS !== "1")
  throw new Error("NODE_ENV=production with a software master key. Use an HSM/KMS-backed KeyProvider, or set ALLOW_SOFTWARE_KEYS=1 to accept the risk knowingly (docs/key-management.md).");
const ctx = await createCtx({
  databaseUrl: process.env.DATABASE_URL,
  keyProvider,
  pepperHex: process.env.PEPPER_HEX,
  log: logUrl ? new HttpTrustLog(logUrl, process.env.APPEND_TOKEN ?? "") : undefined,
});
if (!keyProvider)
  console.warn("No master key set (MASTER_KEY_HEX or MASTER_KEYS): using a random key. Data will be unreadable after restart. Dev only.");
else if (keyProvider.software) console.warn(`Software master key ring in use (active "${keyProvider.activeId}"). Not an HSM; see docs/key-management.md.`);

const dep = await recordDeployment(ctx);
console.log(`configuration ${ctx.config.fingerprint.slice(0, 16)}… (${ctx.config.pack.id} v${ctx.config.pack.version} + ${ctx.config.party.party})${dep.changed ? " recorded on the public log" : " unchanged"}`);

const lab = process.env.LAB_ENABLED === "1";
const ussdSecret = process.env.USSD_WEBHOOK_SECRET || undefined;
if (ussdSecret && ussdSecret.length < 16) throw new Error("USSD_WEBHOOK_SECRET is too short (16 characters or more)");
if (!ussdSecret && !lab)
  throw new Error("USSD_WEBHOOK_SECRET is not set. The USSD webhook trusts the phone number it is sent, so it only runs for a caller that proves it is the gateway. Set the secret (see .env.example).");
if (!ussdSecret) console.warn("USSD_WEBHOOK_SECRET not set: only the lab simulator route /ussd/sim is available. Demo only.");

const app = buildServer(ctx, {
  trustProxy: process.env.TRUST_PROXY === "1",
  ussd: {
    secret: ussdSecret,
    allowedIps: process.env.USSD_ALLOWED_IPS?.split(",").map((s) => s.trim()).filter(Boolean),
    sim: lab,
  },
});
if (lab) registerLab(app); // sandboxed scenario runner; never touches this database
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
