#!/usr/bin/env node
// Runs every test suite and writes reports/latest.json for the portal's "Test results" page.
// Usage: npm run report   (exit code is non-zero if any test failed; the report is written either way)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clip = (s, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const ANSI = /\u001b\[[0-9;]*m/g;

/** Readable areas for Go tests, by name. First match wins. */
const GO_AREAS = [
  [/^Test(ProofRoundTrip|Upgrade|OnlyConfiguredCalendars|AnchorOTS|CalendarDown|OneBadCalendar|GarbageProofs)/, "Anchoring (OpenTimestamps)"],
  [/SignedHead/, "Signed heads"],
  [/Inclusion|Consistency|Rewritten|Persistence/, "Merkle log"],
];
const goArea = (name) => GO_AREAS.find(([re]) => re.test(name))?.[1] ?? "Other";

/** Fold `go test -json` output (one JSON object per line) into groups of tests. */
export function parseGoJson(text) {
  const tests = new Map();
  let buildFailure = "";
  for (const line of text.split(/\r?\n/)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.Test) {
      if (e.Action === "output" && /FAIL|cannot|undefined|error/i.test(e.Output ?? "")) buildFailure += e.Output;
      continue;
    }
    const t = tests.get(e.Test) ?? { name: e.Test, status: "running", ms: 0, out: "" };
    if (e.Action === "output") t.out += e.Output;
    if (e.Action === "pass" || e.Action === "fail" || e.Action === "skip") {
      t.status = e.Action === "pass" ? "passed" : e.Action === "fail" ? "failed" : "skipped";
      t.ms = Math.round((e.Elapsed ?? 0) * 1000);
    }
    tests.set(e.Test, t);
  }
  const groups = new Map();
  for (const t of tests.values()) {
    if (t.name.includes("/")) continue; // subtests roll up into their parent
    const g = goArea(t.name);
    if (!groups.has(g)) groups.set(g, []);
    const entry = { name: t.name.replace(/^Test/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"), status: t.status === "running" ? "failed" : t.status, ms: t.ms };
    if (entry.status === "failed") entry.error = clip((t.out || "no output").replace(ANSI, "").trim());
    groups.get(g).push(entry);
  }
  const out = [...groups].map(([name, ts]) => ({ name, tests: ts }));
  if (!out.length && buildFailure) out.push({ name: "Build", tests: [{ name: "go test did not run", status: "failed", ms: 0, error: clip(buildFailure.replace(ANSI, "").trim()) }] });
  return out;
}

/** Fold vitest's JSON reporter output into groups (one per describe block, falling back to the file). */
export function parseVitest(json) {
  const groups = new Map();
  for (const file of json.testResults ?? []) {
    const fileName = basename(file.name ?? "tests").replace(/\.test\.[tj]s$/, "");
    const results = file.assertionResults ?? [];
    if (!results.length && file.status === "failed") {
      groups.set(fileName, [{ name: "suite failed to load", status: "failed", ms: 0, error: clip((file.message ?? "").replace(ANSI, "")) }]);
      continue;
    }
    for (const r of results) {
      const g = r.ancestorTitles?.[0] ? r.ancestorTitles.join(" > ") : fileName;
      if (!groups.has(g)) groups.set(g, []);
      const status = r.status === "passed" ? "passed" : r.status === "failed" ? "failed" : "skipped";
      const t = { name: r.title, status, ms: Math.round(r.duration ?? 0) };
      if (status === "failed") t.error = clip((r.failureMessages ?? []).join("\n").replace(ANSI, "").trim() || "failed");
      groups.get(g).push(t);
    }
  }
  return [...groups].map(([name, tests]) => ({ name, tests }));
}

/** Fold node:test TAP output (`node --test --test-reporter=tap`) into one group. Only top-level lines count. */
export function parseTap(text, groupName = "Tooling") {
  const tests = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not )?ok \d+ - (.+?)(?: # (SKIP|TODO).*)?$/.exec(lines[i]);
    if (!m) continue;
    let ms = 0;
    let error;
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      const d = /duration_ms:\s*([\d.]+)/.exec(lines[j]);
      if (d) ms = Math.round(Number(d[1]));
      const e = /^\s+error:\s*(.*)$/.exec(lines[j]);
      if (e) error = e[1].replace(/^['"]|['"]$/g, "");
    }
    const status = m[3] ? "skipped" : m[1] ? "failed" : "passed";
    const t = { name: m[2], status, ms };
    if (status === "failed") t.error = clip((error ?? "failed").replace(ANSI, ""));
    tests.push(t);
  }
  return tests.length ? [{ name: groupName, tests }] : [];
}

export function summarise(id, name, tool, groups, durationMs) {
  const all = groups.flatMap((g) => g.tests);
  const count = (s) => all.filter((t) => t.status === s).length;
  return { id, name, tool, passed: count("passed"), failed: count("failed"), skipped: count("skipped"), durationMs, groups };
}

export function buildReport(suites, startedAt) {
  const sum = (k) => suites.reduce((n, s) => n + s[k], 0);
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totals: { passed: sum("passed"), failed: sum("failed"), skipped: sum("skipped") },
    suites,
  };
}

// ---- running the suites ------------------------------------------------------------------------

function run(cmd, args, cwd) {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 256 * 1024 * 1024 });
  return { ...r, ms: Date.now() - t };
}

function vitestSuite(root, id, name, dir) {
  const tmp = mkdtempSync(join(tmpdir(), "op-report-"));
  const out = join(tmp, "vitest.json");
  const r = run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], join(root, dir));
  try {
    if (!existsSync(out)) throw new Error((r.stderr || r.stdout || "vitest produced no report").toString());
    return summarise(id, name, "vitest", parseVitest(JSON.parse(readFileSync(out, "utf8"))), r.ms);
  } catch (e) {
    return summarise(id, name, "vitest", [{ name: "Runner", tests: [{ name: "vitest did not produce results", status: "failed", ms: 0, error: clip(String(e.message ?? e).replace(ANSI, "")) }] }], r.ms);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function toolsSuite(root) {
  const r = run("node", ["--test", "--test-reporter=tap", "scripts/test-report.test.mjs", "scripts/prepublish-check.test.mjs"], root);
  const groups = parseTap(r.stdout ?? "", "Report script and publish check");
  if (!groups.length) groups.push({ name: "Runner", tests: [{ name: "node --test produced no results", status: "failed", ms: 0, error: clip(String(r.stderr ?? "").replace(ANSI, "")) }] });
  return summarise("tools", "Repository tooling (Node)", "node --test", groups, r.ms);
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const started = Date.now();
  const log = (m) => console.log(`[report] ${m}`);

  log("Go trust log…");
  const go = run("go", ["test", "-count=1", "-json", "./..."], join(root, "services/trustlog"));
  const suites = [summarise("trustlog", "Public log and anchoring (Go)", "go test", parseGoJson(go.stdout ?? ""), go.ms)];
  log("Platform (acceptance + lab scenarios)…");
  suites.push(vitestSuite(root, "platform", "Platform: rules, finance, USSD, lab (TypeScript)", "services/platform"));
  log("Portal verifier…");
  suites.push(vitestSuite(root, "portal", "Portal: in-browser log verifier", "apps/portal"));

  log("Repository tooling…");
  suites.push(toolsSuite(root));

  const report = buildReport(suites, started);
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports/latest.json"), JSON.stringify(report, null, 2));
  for (const s of suites) log(`${s.name}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (${(s.durationMs / 1000).toFixed(1)}s)`);
  log(`Total: ${report.totals.passed} passed, ${report.totals.failed} failed. Written to reports/latest.json`);
  process.exit(report.totals.failed > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
