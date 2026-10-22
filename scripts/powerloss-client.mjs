#!/usr/bin/env node
// Client for a real power-cut test of the trust log. Run it on a DIFFERENT machine from the log:
//
//   node scripts/powerloss-client.mjs --log http://LOG-HOST:8080 --token <APPEND_TOKEN> --out acked.txt
//
// It appends entries to the log as fast as it can and writes each index the log ACKNOWLEDGED to `acked.txt`, flushing that
// file to disk each time, so the record of what the log promised survives even if this machine is also disturbed. Cut the
// power to the log host while it runs. When the host is back, copy acked.txt next to the log file and run:
//
//   trustlog verify -file DATA/log.jsonl -acked acked.txt
//
// Use a SCRATCH log, never a production one: the entries it writes are junk and, on a real log, are public and permanent.
// See docs/power-loss-test.md.
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg("log", "http://localhost:8080").replace(/\/$/, "");
const token = arg("token", process.env.APPEND_TOKEN ?? "");
const out = arg("out", "acked.txt");
const concurrency = Number(arg("concurrency", "4"));
if (!token) { console.error("Set --token (the log's APPEND_TOKEN)."); process.exit(2); }

const fd = openSync(out, "a");
const run = randomUUID().slice(0, 8);
let n = 0, acked = 0, highest = -1, failures = 0;

async function worker() {
  while (failures < 20) {
    const i = n++;
    try {
      const r = await fetch(`${base}/append`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "powerloss.test", run, n: i, oid: `pl-${run}-${i}` }),
        signal: AbortSignal.timeout(4000),
      });
      if (r.status === 200 || r.status === 201) {
        const { index } = await r.json();
        writeSync(fd, `${index}\n`);
        fsyncSync(fd); // the promise is recorded before we count it
        acked++;
        if (index > highest) highest = index;
        failures = 0;
      } else failures++;
    } catch {
      failures++; // the log host is gone (power cut) or unreachable
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
const timer = setInterval(() => process.stdout.write(`\racknowledged ${acked}, highest index ${highest}   `), 500);
await Promise.all(Array.from({ length: concurrency }, worker));
clearInterval(timer);
closeSync(fd);
console.log(`\nStopped after repeated failures. The log acknowledged ${acked} entries (highest index ${highest}); indexes are in ${out}.`);
console.log("When the log host is back, run on it:  trustlog verify -file DATA/log.jsonl -acked " + out);
