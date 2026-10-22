#!/usr/bin/env node
// Crash test for the Docker stack. Drives USSD joins and dues payments while randomly SIGKILLing the platform, the trust log
// and the database, then checks that nothing was lost, duplicated or left disagreeing between the database and the public log.
//
//   node scripts/chaos.mjs --secret <USSD_WEBHOOK_SECRET> [--seconds 60] [--users 6] [--kills 8] [--no-postgres]
//
// Needs the stack from docker-compose.yml running. It adds real (simulated) members and payments to that stack.
// This is PROCESS-crash testing (docker kill = SIGKILL). It is not a power-loss test: the host's page cache survives.
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);
const platform = arg("platform", "http://localhost:3000");
const logUrl = arg("log", "http://localhost:8080");
const secret = arg("secret", process.env.USSD_WEBHOOK_SECRET ?? "");
const seconds = Number(arg("seconds", "60"));
const users = Number(arg("users", "6"));
const kills = Number(arg("kills", "8"));
if (!secret) { console.error("Set --secret (the USSD_WEBHOOK_SECRET of the stack)."); process.exit(2); }

const dc = (...a) => execFileSync("docker", ["compose", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sql = (q) => dc("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "openparty", "-At", "-c", q).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function logEvents() {
  const out = [];
  for (let next = 0; ;) {
    const r = await fetch(`${logUrl}/entries?from=${next}`);
    const p = await r.json();
    for (const e of p.entries) { try { out.push(JSON.parse(Buffer.from(e, "base64").toString())); } catch { out.push({}); } }
    next = p.next;
    if (next >= p.size) return out;
  }
}
const countType = (evs, t) => evs.filter((e) => e.type === t).length;

// ---- baseline ---------------------------------------------------------------------------------------------------------
const base = {
  members: Number(sql("select count(*) from members")),
  dues: Number(sql("select count(*) from finance_ledger where kind='dues'")),
  events: await logEvents(),
};
log(`baseline: ${base.members} members, ${base.dues} dues rows, ${base.events.length} log entries`);

// ---- traffic ----------------------------------------------------------------------------------------------------------
const acked = { joined: 0, dues: 0 };
const outcome = { attempted: 0, transportErrors: 0, refused: 0 };
const used = new Set();
const fresh = () => { for (;;) { const nin = String(randomInt(1, 10)) + String(randomInt(0, 1e10)).padStart(10, "0"); const phone = `+2348${String(randomInt(0, 1e9)).padStart(9, "0")}`; if (!used.has(nin) && !used.has(phone)) { used.add(nin); used.add(phone); return { nin, phone }; } } };
async function dial(phone, session, text) {
  const body = new URLSearchParams({ phoneNumber: phone, sessionId: session, text });
  const r = await fetch(`${platform}/ussd`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-ussd-secret": secret }, body, signal: AbortSignal.timeout(8000) });
  return r.status === 200 ? await r.text() : (outcome.refused++, `HTTP ${r.status}`);
}
let stop = false;
async function user() {
  while (!stop) {
    const { nin, phone } = fresh();
    const pin = String(randomInt(1000, 10000));
    const session = `chaos-${Date.now()}-${randomInt(1e9)}`;
    try {
      let joined = false;
      for (const text of ["", "1", `1*${nin}`, `1*${nin}*1`, `1*${nin}*1*1`, `1*${nin}*1*1*${pin}`]) { outcome.attempted++; await dial(phone, session, text); }
      outcome.attempted++;
      const r = await dial(phone, session, `1*${nin}*1*1*${pin}*${pin}`);
      if (/^END You have joined/.test(r)) { acked.joined++; joined = true; }
      if (joined) {
        outcome.attempted++;
        const d = await dial(phone, `${session}-d`, `2*${pin}*500`);
        if (/^END Dues of/.test(d)) acked.dues++;
      }
    } catch { outcome.transportErrors++; await sleep(300); }
  }
}

// ---- chaos ------------------------------------------------------------------------------------------------------------
const targets = ["platform", "trustlog", ...(has("no-postgres") ? [] : ["postgres"])];
async function chaos() {
  const gap = (seconds * 1000) / (kills + 1);
  for (let i = 0; i < kills && !stop; i++) {
    await sleep(gap * (0.6 + Math.random() * 0.8));
    const t = targets[randomInt(targets.length)];
    try { execFileSync("docker", ["kill", "-s", "KILL", `openparty-${t}-1`], { stdio: "ignore" }); log(`KILLED ${t} (${i + 1}/${kills})`); } catch { log(`could not kill ${t}`); }
    await sleep(2500);
    try { dc("up", "-d", t); } catch { /* restart policy may already have done it */ }
  }
}

log(`driving ${users} users for ${seconds}s with ${kills} kills among: ${targets.join(", ")}`);
const workers = Array.from({ length: users }, user);
const killer = chaos();
await sleep(seconds * 1000);
stop = true;
await killer;
await Promise.allSettled(workers);

// ---- recovery ---------------------------------------------------------------------------------------------------------
log("traffic stopped; bringing everything back and waiting for the outbox to drain");
dc("up", "-d");
let health = null;
for (let i = 0; i < 90; i++) {
  health = await fetch(`${platform}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  if (health?.outbox && health.outbox.pending === 0) break;
  await sleep(1000);
}
log("platform health:", JSON.stringify(health));

// ---- checks -----------------------------------------------------------------------------------------------------------
const after = {
  members: Number(sql("select count(*) from members")),
  dues: Number(sql("select count(*) from finance_ledger where kind='dues'")),
  events: await logEvents(),
};
const dMembers = after.members - base.members;
const dDues = after.dues - base.dues;
const dJoinedEv = countType(after.events, "member.joined") - countType(base.events, "member.joined");
const dDuesEv = countType(after.events, "finance.dues") - countType(base.events, "finance.dues");

const problems = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) problems.push(msg); };
console.log(`\nacknowledged to users: ${acked.joined} joins, ${acked.dues} dues. attempts ${outcome.attempted}, transport errors ${outcome.transportErrors}, refused ${outcome.refused}`);
console.log(`database grew: ${dMembers} members, ${dDues} dues rows. log grew: ${dJoinedEv} member.joined, ${dDuesEv} finance.dues events\n`);
check(health?.outbox?.pending === 0, "the outbox drained (nothing waiting to reach the log)");
check(dMembers >= acked.joined, "every join a user was told succeeded is in the database");
check(dDues >= acked.dues, "every dues payment a user was told succeeded is in the ledger");
check(dMembers === dJoinedEv, "joins in the database == member.joined events in the log (no event lost, none duplicated)");
check(dDues === dDuesEv, "dues in the ledger == finance.dues events in the log");
let cons = null;
try { cons = JSON.parse(dc("exec", "-T", "platform", "npx", "tsx", "src/verify-consistency.ts")); } catch (e) { try { cons = JSON.parse(e.stdout); } catch { /* not JSON */ } }
check(cons?.ok === true, `verify:consistency agrees (${cons ? `${cons.stats.outboxPublished} published, ${cons.problems.length} problems` : "did not run"})`);
if (cons && !cons.ok) for (const p of cons.problems.slice(0, 10)) console.log("   -", p);
// Ambiguous outcomes are allowed (a request can succeed and its answer be lost), but never more rows than attempts.
check(dMembers <= outcome.attempted, "no more members than join attempts");

console.log(problems.length ? `\n${problems.length} problem(s). The stack is NOT consistent.` : "\nAll checks passed.");
process.exit(problems.length ? 1 : 0);
