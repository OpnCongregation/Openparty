#!/usr/bin/env node
// Runs the Vault Transit tests against a real, throwaway Vault server (dev mode: in memory, root token "root").
// Starts hashicorp/vault on 127.0.0.1:18200, runs test/vault.test.ts with VAULT_TEST_ADDR set, and removes the container.
// A dev-mode Vault is for testing only: production Vault needs storage, TLS, auto-unseal and access policies (docs/key-management.md).
import { execFileSync, spawnSync } from "node:child_process";

const name = "openparty-test-vault";
const port = process.env.TEST_VAULT_PORT ?? "18200";
const run = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { run("rm", "-f", name); } catch { /* none */ }
run("run", "-d", "--rm", "--name", name, "--cap-add=IPC_LOCK", "-p", `127.0.0.1:${port}:8200`,
  "-e", "VAULT_DEV_ROOT_TOKEN_ID=root", "-e", "VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200", "hashicorp/vault:1.15");
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/v1/sys/health`); ready = r.ok; } catch { /* starting */ }
  if (!ready) await sleep(1000);
}
if (!ready) { try { run("rm", "-f", name); } catch {} console.error("Vault did not start."); process.exit(2); }
console.log(`Vault ready on 127.0.0.1:${port}; running the Vault tests against it...`);
const res = spawnSync("npx", ["vitest", "run", "test/vault.test.ts", ...process.argv.slice(2)], {
  cwd: new URL("../services/platform/", import.meta.url), stdio: "inherit", shell: true,
  env: { ...process.env, VAULT_TEST_ADDR: `http://127.0.0.1:${port}` },
});
try { run("rm", "-f", name); } catch { /* already gone */ }
process.exit(res.status ?? 1);
