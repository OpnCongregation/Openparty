#!/usr/bin/env node
// F-10 acceptance test on the Docker stack: approved actions take effect exactly once, even while the platform and database are
// SIGKILLed in the middle of approving. Drives real signed admin requests (propose, then approve), kills processes at random,
// waits for recovery to finish, and checks approved == applied == announced, with nothing left half-done.
//
//   node scripts/chaos-approvals.mjs [--seconds 40] [--workers 4] [--kills 5]
//
// It registers throw-away admins in the database through psql and changes four editable rules (dues, petition and donor-cap window settings)
// on the stack, so use a test stack. It starts the platform with a short approval lease (10 s) so recovery is quick.
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const platform = arg("platform", "http://localhost:3000");
const logUrl = arg("log", "http://localhost:8080");
const seconds = Number(arg("seconds", "40")), workers = Number(arg("workers", "4")), kills = Number(arg("kills", "5"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dc = (env, ...a) => execFileSync("docker", ["compose", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
const sql = (q) => dc({}, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "openparty", "-At", "-c", q).trim();
const problems = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) problems.push(msg); };

// Short lease so a killed claimant is taken over within seconds.
const LEASE = { APPROVAL_LEASE_SECONDS: "10", APPROVAL_RECOVERY_SECONDS: "5" };
dc(LEASE, "up", "-d", "platform");
async function healthy(n = 90) { for (let i = 0; i < n; i++) { try { const r = await fetch(`${platform}/healthz`, { signal: AbortSignal.timeout(2500) }); if (r.ok) return await r.json(); } catch {} await sleep(1000); } return null; }
await healthy();

// ---- throw-away admins: a secretary proposes, an electoral committee member approves ------------------------------------------
function admin(role) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomUUID();
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  sql(`insert into admins(id,name,role,public_key) values ('${id}','chaos-${role}','${role}','${pub}')`);
  return { id, role, headers(method, path, body = "") {
    const ts = String(Date.now());
    const sig = sign(null, Buffer.from(`${ts}\n${method}\n${path}\n${createHash("sha256").update(body).digest("hex")}`), privateKey).toString("hex");
    return { "x-admin-id": id, "x-timestamp": ts, "x-signature": sig, "content-type": "application/json" };
  } };
}
const sec = admin("secretary"), ec = admin("electoral_committee");
async function call(a, method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const r = await fetch(`${platform}${path}`, { method, headers: a.headers(method, path, raw), body: raw || undefined, signal: AbortSignal.timeout(8000) });
  return { code: r.status, json: await r.json().catch(() => ({})) };
}

const base = {
  rules: Number(sql("select count(*) from rules")),
  approvals: Number(sql("select count(*) from approvals")),
  executedEv: Number(sql("select count(*) from log_outbox where type='approval.executed'")),
  ruleEv: Number(sql("select count(*) from log_outbox where type='rule.set'")),
};
const KEYS = [["dues.min_payment_minor", (i) => 10000 + (i % 50) * 100], ["proposals.threshold", (i) => 100 + (i % 50)], ["proposals.response_days", (i) => 30 + (i % 20)], ["finance.cap_window_days", (i) => 300 + (i % 60)]];
const acked = new Set(), proposed = new Set();
let stop = false, transport = 0;
async function worker(w) {
  const [key, val] = KEYS[w % KEYS.length]; // one rule key per worker, so versions never race each other
  for (let i = 0; !stop; i++) {
    try {
      const p = await call(sec, "POST", "/admin/approvals", { action: "rule.set", payload: { key, value: val(i) } });
      if (p.code !== 200 || !p.json.id) continue;
      proposed.add(p.json.id);
      const a = await call(ec, "POST", `/admin/approvals/${p.json.id}/approve`);
      if (a.code === 200 && a.json.executed === true) acked.add(p.json.id);
    } catch { transport++; await sleep(300); }
  }
}

log(`${workers} workers for ${seconds}s, ${kills} kills among platform/postgres (lease 10 s)`);
const ws = Array.from({ length: workers }, (_, w) => worker(w));
(async () => {
  for (let i = 0; i < kills; i++) {
    await sleep((seconds * 1000) / (kills + 1) * (0.6 + Math.random() * 0.8));
    const t = Math.random() < 0.75 ? "platform" : "postgres";
    try { execFileSync("docker", ["kill", "-s", "KILL", `openparty-${t}-1`], { stdio: "ignore" }); log(`KILLED ${t} (${i + 1}/${kills})`); } catch {}
    await sleep(2000);
    try { dc(LEASE, "up", "-d", t); } catch {}
  }
})();
await sleep(seconds * 1000);
stop = true;
await Promise.allSettled(ws);

// ---- recovery -----------------------------------------------------------------------------------------------------------------
log("traffic stopped; waiting for recovery to finish every claimed approval");
dc(LEASE, "up", "-d");
await healthy();
let left = -1;
for (let i = 0; i < 120; i++) { try { left = Number(sql("select count(*) from approvals where status='executing'")); } catch { left = -1; } if (left === 0) break; await sleep(1000); }
for (let i = 0; i < 60; i++) { const h = await healthy(2); if (h?.outbox?.pending === 0) break; await sleep(1000); }

const st = Object.fromEntries(sql("select status, count(*) from approvals group by 1").split("\n").filter(Boolean).map((l) => l.split("|")));
const executed = Number(sql("select count(*) from approvals where status='executed'")) - 0;
const dRules = Number(sql("select count(*) from rules")) - base.rules;
const dApprovals = Number(sql("select count(*) from approvals")) - base.approvals;
const dExecEv = Number(sql("select count(*) from log_outbox where type='approval.executed'")) - base.executedEv;
const dRuleEv = Number(sql("select count(*) from log_outbox where type='rule.set'")) - base.ruleEv;
const ackedNotExecuted = [...acked].filter((id) => sql(`select status from approvals where id='${id}'`) !== "executed").length;
console.log(`\nproposed ${proposed.size}, approved-and-acknowledged ${acked.size}, transport errors ${transport}; statuses: ${JSON.stringify(st)}`);
console.log(`since the start: ${dApprovals} approvals, ${dRules} rule versions, ${dRuleEv} rule.set events, ${dExecEv} approval.executed events\n`);
check(left === 0, "no approval is left in 'executing' (recovery finished them all)");
check(ackedNotExecuted === 0, "every approval acknowledged as executed is executed");
check(dRules === dExecEv, "rule versions written == approval.executed events: each executed approval took effect exactly once");
check(dRuleEv === dRules, "rule.set events == rule versions: nothing applied silently, nothing announced twice");
let cons = null;
try { cons = JSON.parse(dc({}, "exec", "-T", "platform", "npx", "tsx", "src/verify-consistency.ts")); } catch (e) { try { cons = JSON.parse(e.stdout); } catch {} }
check(cons?.ok === true, `verify:consistency agrees (${cons ? `${cons.problems.length} problems` : "did not run"})`);
if (cons && !cons.ok) for (const p of cons.problems.slice(0, 8)) console.log("   -", p);
dc({}, "up", "-d", "platform"); // back to the normal lease
console.log(problems.length ? `\n${problems.length} problem(s).` : "\nAll checks passed.");
process.exit(problems.length ? 1 : 0);
