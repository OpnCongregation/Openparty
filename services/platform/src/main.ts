import { createCtx } from "./platform.js";
import { pepperRingFromEnv } from "./crypto.js";
import { loadKeyProvider } from "./vault-provider.js";
import { recoverApprovals } from "./admin.js";
import { buildServer } from "./server.js";
import { HttpTrustLog } from "./adapters.js";
import { registerLab } from "./lab.js";
import { sendRecordNotices } from "./record-notices.js";
import { recordDeployment } from "./framework/deploy.js";

const envNum = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
const logUrl = process.env.TRUSTLOG_URL;
const keyProvider = await loadKeyProvider(process.env);
const peppers = pepperRingFromEnv(process.env);
// The only key provider so far holds the master key in this process's memory. That is not an HSM, so a production
// start must say so explicitly instead of looking compliant by accident.
if (process.env.NODE_ENV === "production" && (!keyProvider || keyProvider.software) && process.env.ALLOW_SOFTWARE_KEYS !== "1")
  throw new Error("NODE_ENV=production with a software master key. Use an HSM/KMS-backed KeyProvider, or set ALLOW_SOFTWARE_KEYS=1 to accept the risk knowingly (docs/key-management.md).");
const ctx = await createCtx({
  databaseUrl: process.env.DATABASE_URL,
  keyProvider,
  peppers,
  log: logUrl ? new HttpTrustLog(logUrl, process.env.APPEND_TOKEN ?? "") : undefined,
});
if (!keyProvider)
  console.warn("No master key set (MASTER_KEY_HEX or MASTER_KEYS): using a random key. Data will be unreadable after restart. Dev only.");
else if (keyProvider.software) console.warn(`Software master key ring in use (active "${keyProvider.activeId}"). Not an HSM; see docs/key-management.md.`);
else console.log(`Master keys are held by the key service (active ${keyProvider.activeId}).`);

const dep = await recordDeployment(ctx);
console.log(`configuration ${ctx.config.fingerprint.slice(0, 16)}… (${ctx.config.pack.id} v${ctx.config.pack.version} + ${ctx.config.party.party})${dep.changed ? " recorded on the public log" : " unchanged"}`);

const lab = process.env.LAB_ENABLED === "1";
const ussdSecret = process.env.USSD_WEBHOOK_SECRET || undefined;
if (ussdSecret && ussdSecret.length < 16) throw new Error("USSD_WEBHOOK_SECRET is too short (16 characters or more)");
if (!ussdSecret && !lab)
  throw new Error("USSD_WEBHOOK_SECRET is not set. The USSD webhook trusts the phone number it is sent, so it only runs for a caller that proves it is the gateway. Set the secret (see .env.example).");
if (!ussdSecret) console.warn("USSD_WEBHOOK_SECRET not set: only the lab simulator route /ussd/sim is available. Demo only.");

// Publish committed events to the public log in the background: this heals the gap left by a crash between commit and publish.
ctx.events.start();
// Finish approvals whose executor died between claiming and applying them (at startup, then every 30 s; safe on every instance).
const leaseSeconds = Number(process.env.APPROVAL_LEASE_SECONDS ?? 60);
const recover = () => recoverApprovals(ctx, leaseSeconds).then((r) => { if (r.recovered || r.failed) console.log(`approvals: recovered ${r.recovered}, gave up on ${r.failed}`); }).catch((e) => console.error("approval recovery:", e?.message ?? e));
void recover();
setInterval(recover, Number(process.env.APPROVAL_RECOVERY_SECONDS ?? 30) * 1000).unref();
// Tell members with incomplete records (and repeat the reminders as the register deadline nears). Safe on every instance.
const notices = () => sendRecordNotices(ctx).then((r) => { if (r.sent || r.failed) console.log(`record notices: sent ${r.sent}, failed ${r.failed}`); }).catch((e) => console.error("record notices:", e?.message ?? e));
void notices();
setInterval(notices, Number(process.env.RECORD_NOTICE_SECONDS ?? 3600) * 1000).unref();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { ctx.events.stop(); void ctx.events.flush().finally(() => process.exit(0)); });

const app = buildServer(ctx, {
  trustProxy: process.env.TRUST_PROXY === "1",
  ussd: {
    secret: ussdSecret,
    allowedIps: process.env.USSD_ALLOWED_IPS?.split(",").map((s) => s.trim()).filter(Boolean),
    sim: lab,
    perIp: envNum("USSD_RATE_AUTHFAIL"),
    perPhone: envNum("USSD_RATE_PER_PHONE"),
    perGateway: envNum("USSD_RATE_PER_GATEWAY"),
  },
});
if (lab) registerLab(app); // sandboxed scenario runner; never touches this database
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
