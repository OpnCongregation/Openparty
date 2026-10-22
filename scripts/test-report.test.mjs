import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, parseGoJson, parseTap, parseVitest, summarise } from "./test-report.mjs";

const ev = (o) => JSON.stringify(o);

test("go: passes, failures with output, grouping and subtest roll-up", () => {
  const text = [
    ev({ Action: "run", Test: "TestInclusionProofsAllSizes" }),
    ev({ Action: "pass", Test: "TestInclusionProofsAllSizes", Elapsed: 0.04 }),
    ev({ Action: "run", Test: "TestUpgradeToBitcoinUsesCorrectCommitment" }),
    ev({ Action: "output", Test: "TestUpgradeToBitcoinUsesCorrectCommitment", Output: "ots_test.go:90: got pending\n" }),
    ev({ Action: "fail", Test: "TestUpgradeToBitcoinUsesCorrectCommitment", Elapsed: 0.01 }),
    ev({ Action: "pass", Test: "TestSignedHeadVerifies/sub", Elapsed: 0 }),
    ev({ Action: "pass", Test: "TestSignedHeadVerifies", Elapsed: 0.01 }),
    "not json",
  ].join("\n");
  const groups = parseGoJson(text);
  const byName = Object.fromEntries(groups.map((g) => [g.name, g.tests]));
  assert.equal(byName["Merkle log"][0].status, "passed");
  assert.equal(byName["Merkle log"][0].name, "Inclusion Proofs All Sizes");
  const bad = byName["Anchoring (OpenTimestamps)"][0];
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /got pending/);
  assert.equal(byName["Signed heads"].length, 1, "subtests must not be counted twice");
});

test("go: a test that never finished is reported as failed, a build error is surfaced", () => {
  const hung = parseGoJson(ev({ Action: "run", Test: "TestPersistenceReload" }));
  assert.equal(hung[0].tests[0].status, "failed");
  const build = parseGoJson(ev({ Action: "output", Output: "./ots.go:10:2: undefined: foo\n" }));
  assert.equal(build[0].tests[0].status, "failed");
  assert.match(build[0].tests[0].error, /undefined: foo/);
});

test("vitest: groups by describe, keeps failure messages, strips colour codes", () => {
  const json = {
    testResults: [
      {
        name: "C:/x/test/acceptance.test.ts",
        status: "failed",
        assertionResults: [
          { ancestorTitles: ["Finance"], title: "anonymous gift rejected", status: "passed", duration: 12.4 },
          { ancestorTitles: ["Finance"], title: "cap", status: "failed", duration: 3, failureMessages: ["\u001b[31mAssertionError: expected 1 to be 2\u001b[39m"] },
          { ancestorTitles: ["Finance"], title: "todo", status: "pending" },
        ],
      },
      { name: "C:/x/test/broken.test.ts", status: "failed", assertionResults: [], message: "SyntaxError: nope" },
    ],
  };
  const groups = parseVitest(json);
  const fin = groups.find((g) => g.name === "Finance");
  assert.deepEqual(fin.tests.map((t) => t.status), ["passed", "failed", "skipped"]);
  assert.equal(fin.tests[0].ms, 12);
  assert.equal(fin.tests[1].error, "AssertionError: expected 1 to be 2");
  const broken = groups.find((g) => g.name === "broken");
  assert.equal(broken.tests[0].status, "failed");
  assert.match(broken.tests[0].error, /SyntaxError/);
});

test("report totals add up across suites", () => {
  const a = summarise("a", "A", "x", [{ name: "g", tests: [{ name: "t", status: "passed", ms: 1 }, { name: "u", status: "failed", ms: 1 }] }], 5);
  const b = summarise("b", "B", "x", [{ name: "g", tests: [{ name: "t", status: "passed", ms: 1 }, { name: "s", status: "skipped", ms: 0 }] }], 5);
  const r = buildReport([a, b], Date.now());
  assert.deepEqual(r.totals, { passed: 2, failed: 1, skipped: 1 });
});

test("tap: passed, failed and skipped tests with durations", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: a",
    "ok 1 - passes",
    "  ---",
    "  duration_ms: 12.6",
    "  ...",
    "not ok 2 - breaks",
    "  ---",
    "  duration_ms: 1",
    "  error: 'expected 1 to equal 2'",
    "  ...",
    "ok 3 - later # SKIP not ready",
    "1..3",
  ].join("\n");
  const [g] = parseTap(tap);
  assert.deepEqual(g.tests.map((t) => t.status), ["passed", "failed", "skipped"]);
  assert.equal(g.tests[0].ms, 13);
  assert.equal(g.tests[1].error, "expected 1 to equal 2");
  assert.deepEqual(parseTap("nothing here"), []);
});
