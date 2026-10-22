#!/usr/bin/env node
// Load test for the platform (USSD journeys) and the public log (reads and proofs). No dependencies (Node 18+).
//
//   node scripts/loadtest.mjs --platform http://localhost:3000 --log http://localhost:8080 --secret <USSD_WEBHOOK_SECRET> \
//        --scenario mixed --steps 5,20,50 --step-seconds 15
//
// Point it at a real deployment by changing the URLs. It writes real members and payments (simulated ones in the demo
// stack), so use a test environment. Results are printed and saved to reports/loadtest-latest.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const platform = arg("platform", "http://localhost:3000").replace(/\/$/, "");
const logUrl = arg("log", "http://localhost:8080").replace(/\/$/, "");
const secret = arg("secret", process.env.USSD_WEBHOOK_SECRET ?? "");
const scenario = arg("scenario", "mixed"); // log | ussd | mixed
const steps = arg("steps", "5,20").split(",").map(Number);
const stepSeconds = Number(arg("step-seconds", "10"));
const ussdPath = arg("ussd-path", secret ? "/ussd" : "/ussd/sim");

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
function summarise(name, lat, codes, seconds, errors) {
  lat.sort((a, b) => a - b);
  const total = lat.length + errors;
  return {
    name, requests: total, perSecond: +(total / seconds).toFixed(1), errors,
    p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1), max: +(lat.at(-1) ?? 0).toFixed(1),
    status: codes,
  };
}

/** Runs `worker` in `concurrency` loops for `seconds`, timing each call it makes through `timed`. */
async function drive(concurrency, seconds, worker) {
  const stats = new Map(); // op name -> {lat:[], codes:{}, errors}
  const timed = async (op, fn) => {
    const s = stats.get(op) ?? { lat: [], codes: {}, errors: 0 };
    stats.set(op, s);
    const t0 = performance.now();
    try {
      const code = await fn();
      s.lat.push(performance.now() - t0);
      s.codes[code] = (s.codes[code] ?? 0) + 1;
    } catch {
      s.errors++;
    }
  };
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
    while (Date.now() < end) await worker(timed, i);
  }));
  return [...stats].map(([op, s]) => summarise(op, s.lat, s.codes, seconds, s.errors));
}

// ---- Log scenario -------------------------------------------------------------------------------------------------
let knownSize = 0;
async function logWorker(timed) {
  // Every call is timed and counted, including the ones the log refuses (429) or fails.
  await timed("log /head", async () => {
    const r = await fetch(`${logUrl}/head`);
    if (r.ok) knownSize = (await r.json()).head.size;
    else await r.arrayBuffer();
    return r.status;
  });
  const size = knownSize;
  if (size < 1) return;
  const pick = randomInt(0, Math.max(1, size));
  await timed("log /entries (page)", async () => { const r = await fetch(`${logUrl}/entries?from=${Math.max(0, size - 50)}`); await r.arrayBuffer(); return r.status; });
  if (size > 1) {
    await timed("log inclusion proof", async () => { const r = await fetch(`${logUrl}/proof/inclusion?index=${pick}&size=${size}`); await r.arrayBuffer(); return r.status; });
    await timed("log consistency proof", async () => { const r = await fetch(`${logUrl}/proof/consistency?old=${Math.max(1, Math.floor(size / 2))}&new=${size}`); await r.arrayBuffer(); return r.status; });
  }
}
// ---- USSD scenario ------------------------------------------------------------------------------------------------
const used = new Set();
function fresh() {
  for (;;) {
    const nin = String(randomInt(1, 10)) + String(randomInt(0, 1e10)).padStart(10, "0");
    const phone = `+2348${String(randomInt(0, 1e9)).padStart(9, "0")}`;
    if (!used.has(nin) && !used.has(phone)) { used.add(nin); used.add(phone); return { nin, phone }; }
  }
}
async function dial(phone, session, text) {
  const body = new URLSearchParams({ phoneNumber: phone, sessionId: session, text });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (ussdPath === "/ussd") headers["x-ussd-secret"] = secret;
  const r = await fetch(`${platform}${ussdPath}`, { method: "POST", headers, body });
  const t = await r.text();
  return { code: r.status, text: t };
}
const journeyOutcomes = { joined: 0, duesPaid: 0, failed: 0 };
async function ussdWorker(timed) {
  const { nin, phone } = fresh();
  const pin = String(randomInt(1000, 10000));
  const session = `lt-${Date.now()}-${randomInt(1e9)}`;
  const steps = ["", "1", `1*${nin}`, `1*${nin}*1`, `1*${nin}*1*1`, `1*${nin}*1*1*${pin}`, `1*${nin}*1*1*${pin}*${pin}`];
  let last = "";
  for (const [i, text] of steps.entries()) {
    const label = i === steps.length - 1 ? "ussd confirm join (scrypt)" : i === 2 ? "ussd verify ID" : "ussd menu step";
    await timed(label, async () => { const r = await dial(phone, session, text); last = r.text; return r.code; });
  }
  if (!/^END You have joined/.test(last)) { journeyOutcomes.failed++; return; }
  journeyOutcomes.joined++;
  await timed("ussd pay dues (scrypt)", async () => { const r = await dial(phone, `${session}-d`, `2*${pin}*500`); if (/^END Dues of/.test(r.text)) journeyOutcomes.duesPaid++; return r.code; });
}

async function mixedWorker(timed, i) {
  return i % 3 === 0 ? logWorker(timed) : ussdWorker(timed);
}

// ---- Run -----------------------------------------------------------------------------------------------------------
const worker = { log: logWorker, ussd: ussdWorker, mixed: mixedWorker }[scenario];
if (!worker) { console.error("--scenario must be log, ussd or mixed"); process.exit(2); }
if (scenario !== "log" && ussdPath === "/ussd" && !secret) { console.error("Set --secret (or USSD_WEBHOOK_SECRET) for the real /ussd route."); process.exit(2); }

const headOf = () => fetch(`${logUrl}/head`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const before = await headOf();
const report = { when: new Date().toISOString(), platform, log: logUrl, scenario, stepSeconds, steps: [] };
console.log(`Load test: ${scenario}, steps ${steps.join(", ")} users x ${stepSeconds}s, ussd route ${ussdPath}`);
for (const c of steps) {
  for (const k of Object.keys(journeyOutcomes)) journeyOutcomes[k] = 0;
  const rows = await drive(c, stepSeconds, worker);
  const health = await fetch(`${platform}/healthz`).then((r) => r.json()).catch(() => null);
  report.steps.push({ concurrency: c, operations: rows, journeys: { ...journeyOutcomes }, outboxAfter: health?.outbox ?? null });
  console.log(`\n== ${c} concurrent users ==`);
  console.table(rows.map((r) => ({ operation: r.name, requests: r.requests, "req/s": r.perSecond, errors: r.errors, "p50 ms": r.p50, "p95 ms": r.p95, "p99 ms": r.p99, "max ms": r.max, status: JSON.stringify(r.status) })));
  if (scenario !== "log") console.log(`journeys: ${journeyOutcomes.joined} joined, ${journeyOutcomes.duesPaid} paid dues, ${journeyOutcomes.failed} failed`);
  if (health) console.log(`outbox: ${health.outbox.pending} pending, oldest ${health.outbox.oldestPendingSeconds ?? 0}s (${health.status})`);
}

// Let the outbox drain, then show the log grew by what the platform says it published.
await new Promise((r) => setTimeout(r, 3000));
const after = await headOf();
if (before && after) report.logGrewBy = after.head.size - before.head.size;
console.log(`\nlog grew by ${report.logGrewBy ?? "?"} entries. Run \`npm run verify:consistency\` (in services/platform) to check them against the database.`);
mkdirSync("reports", { recursive: true });
writeFileSync("reports/loadtest-latest.json", JSON.stringify(report, null, 2));
console.log("saved reports/loadtest-latest.json");
