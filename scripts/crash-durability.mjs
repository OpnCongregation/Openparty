#!/usr/bin/env node
// F-11 acceptance test, on the Docker stack: security-critical counters survive an unclean database crash.
//   node scripts/crash-durability.mjs --secret <USSD_WEBHOOK_SECRET>
// 1. Exhaust the failed-gateway-authentication budget from this address (429), SIGKILL postgres, restart: still 429.
// 2. Lock a member's PIN with wrong guesses, SIGKILL postgres, restart: still locked (even the correct PIN is refused).
// 3. Control: the per-phone VOLUME counter is allowed to reset; the result is reported, not asserted.
// It uses the real USSD webhook. It adds one member to the stack. Run it only on a test stack.
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const platform = arg("platform", "http://localhost:3000");
const secret = arg("secret", process.env.USSD_WEBHOOK_SECRET ?? "");
if (!secret) { console.error("Set --secret."); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dc = (...a) => execFileSync("docker", ["compose", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const problems = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) problems.push(msg); };

async function dial(phone, text, headers = { "x-ussd-secret": secret }, session = `cd-${Date.now()}-${randomInt(1e9)}`) {
  const r = await fetch(`${platform}/ussd`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ phoneNumber: phone, sessionId: session, text }), signal: AbortSignal.timeout(8000) });
  return { code: r.status, text: await r.text() };
}
async function crashPostgres() {
  execFileSync("docker", ["kill", "-s", "KILL", "openparty-postgres-1"], { stdio: "ignore" });
  await sleep(1500);
  dc("up", "-d", "postgres");
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${platform}/healthz`, { signal: AbortSignal.timeout(2500) }); if (r.ok) return; } catch { /* still down */ } await sleep(1000); }
  throw new Error("platform did not come back after the database crash");
}
async function waitHealthy() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${platform}/healthz`)).ok) return; } catch {} await sleep(1000); } }
await waitHealthy();

// ---- 1. authentication-failure budget -------------------------------------------------------------------------------
console.log("\n1. Failed gateway authentication budget (must survive a database crash)");
const limit = Number(process.env.USSD_RATE_AUTHFAIL ?? 20);
const tries = [];
for (let i = 0; i < limit + 8; i++) tries.push((await dial("+2348055500555", "", { "x-ussd-secret": `wrong-${i}` })).code);
const blocked = tries.filter((c) => c === 429).length;
check(blocked > 0 && tries.at(-1) === 429, `after ${limit} wrong secrets the address is throttled (${tries.filter((c) => c === 401).length}x 401, ${blocked}x 429)`);
await crashPostgres();
const after = (await dial("+2348055500555", "", { "x-ussd-secret": "wrong-again" })).code;
check(after === 429, `after SIGKILL of postgres and restart the budget is still exhausted (got ${after})`);

// ---- 2. PIN lock ------------------------------------------------------------------------------------------------------
console.log("\n2. PIN lock (must survive a database crash)");
const phone = `+2348${String(randomInt(0, 1e9)).padStart(9, "0")}`;
const nin = String(randomInt(1, 10)) + String(randomInt(0, 1e10)).padStart(10, "0");
const sess = `cd-join-${Date.now()}`;
for (const t of ["", "1", `1*${nin}`, `1*${nin}*1`, `1*${nin}*1*1`, `1*${nin}*1*1*4321`]) await dial(phone, t, undefined, sess);
const joined = await dial(phone, `1*${nin}*1*1*4321*4321`, undefined, sess);
check(/You have joined/.test(joined.text), "a test member joined");
const wrong = [];
for (let i = 0; i < 5; i++) wrong.push((await dial(phone, "3*0000")).text);
check(wrong.every((t) => /Wrong PIN/.test(t)), "five wrong PINs were each refused as wrong");
const locked1 = (await dial(phone, "3*4321")).text;
check(/locked|Too many/i.test(locked1), `the correct PIN is now refused ("${locked1.slice(0, 50).replace(/\n/g, " ")}")`);
await crashPostgres();
const locked2 = (await dial(phone, "3*4321")).text;
check(/locked|Too many/i.test(locked2), `after SIGKILL of postgres and restart the PIN is still locked ("${locked2.slice(0, 50).replace(/\n/g, " ")}")`);

// ---- 3. control: a volume counter may reset -------------------------------------------------------------------------------
console.log("\n3. Control: the per-phone volume counter is allowed to reset (reported, not asserted)");
const vphone = "+2348055500666";
const perPhone = Number(process.env.USSD_RATE_PER_PHONE ?? 30);
let seen429 = false;
for (let i = 0; i < perPhone + 5; i++) if ((await dial(vphone, "")).code === 429) seen429 = true;
await crashPostgres();
const afterVol = (await dial(vphone, "")).code;
console.log(`   throttled before the crash: ${seen429}; after: ${afterVol === 429 ? "still throttled (this process's own memory remembered it, or the table survived)" : "allowed again (counter reset, which is permitted for volume limits)"}`);

console.log(problems.length ? `\n${problems.length} problem(s).` : "\nAll durability checks passed.");
process.exit(problems.length ? 1 : 0);
