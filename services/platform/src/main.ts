import { createCtx } from "./platform.js";
import { buildServer } from "./server.js";
import { HttpTrustLog } from "./adapters.js";
import { registerLab } from "./lab.js";
import { recordDeployment } from "./framework/deploy.js";

const logUrl = process.env.TRUSTLOG_URL;
const ctx = await createCtx({
  databaseUrl: process.env.DATABASE_URL,
  masterKeyHex: process.env.MASTER_KEY_HEX,
  pepperHex: process.env.PEPPER_HEX,
  log: logUrl ? new HttpTrustLog(logUrl, process.env.APPEND_TOKEN ?? "") : undefined,
});
if (!process.env.MASTER_KEY_HEX)
  console.warn("MASTER_KEY_HEX not set: using a random key. Data will be unreadable after restart. Dev only.");

const dep = await recordDeployment(ctx);
console.log(`configuration ${ctx.config.fingerprint.slice(0, 16)}… (${ctx.config.pack.id} v${ctx.config.pack.version} + ${ctx.config.party.party})${dep.changed ? " recorded on the public log" : " unchanged"}`);

const app = buildServer(ctx);
if (process.env.LAB_ENABLED === "1") registerLab(app); // sandboxed scenario runner; never touches this database
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
