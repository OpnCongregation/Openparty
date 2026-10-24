#!/usr/bin/env node
// Builds the ElectionGuard service image, starts a throwaway container, runs the platform's real-service election test against it
// (test/secret-ballot-real.test.ts: a five-guardian ceremony, encrypted votes, a tally opened by three guardians, the paper audit), and
// removes the container. Needs Docker. It takes several minutes: the reference library is pure Python and does real cryptography.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const name = "openparty-test-eg";
const port = process.env.TEST_EG_PORT ?? "18090";
const token = randomBytes(16).toString("hex");
const run = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rm = () => { try { run("rm", "-f", name); } catch { /* none */ } };

rm();
console.log("Building the ElectionGuard image...");
run("build", "-q", "-t", "openparty-eg:test", new URL("../services/electionguard/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
run("run", "-d", "--rm", "--name", name, "-e", `EG_TOKEN=${token}`, "-e", "EG_ENABLE_GUARDIAN_OPS=1", "-p", `127.0.0.1:${port}:8090`, "openparty-eg:test");
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* starting */ }
  if (!ready) await sleep(1000);
}
if (!ready) { rm(); console.error("The ElectionGuard service did not start."); process.exit(2); }
console.log(`ElectionGuard service ready on 127.0.0.1:${port}; running the election against it (this takes a few minutes)...`);
const res = spawnSync("npx", ["vitest", "run", "test/secret-ballot-real.test.ts", ...process.argv.slice(2)], {
  cwd: new URL("../services/platform/", import.meta.url),
  stdio: "inherit", shell: true,
  env: { ...process.env, EG_TEST_URL: `http://127.0.0.1:${port}`, EG_TEST_TOKEN: token },
});
rm();
process.exit(res.status ?? 1);
