#!/usr/bin/env node
// Runs the whole platform test suite against a real PostgreSQL server (the normal run uses an embedded one).
// Starts a throwaway postgres:16 container on 127.0.0.1:55432, runs vitest with OPENPARTY_TEST_DATABASE_URL pointing at it
// (each test gets its own schema), and removes the container. Needs Docker.
import { execFileSync, spawnSync } from "node:child_process";

const name = "openparty-test-pg";
const port = process.env.TEST_PG_PORT ?? "55432";
const run = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { run("rm", "-f", name); } catch { /* none */ }
run("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=test", "-p", `127.0.0.1:${port}:5432`, "postgres:16", "-c", "max_connections=500", "-c", "fsync=off");
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try { run("exec", name, "pg_isready", "-U", "postgres"); ready = true; } catch { await sleep(1000); }
}
if (!ready) { try { run("rm", "-f", name); } catch {} console.error("Postgres did not start."); process.exit(2); }
await sleep(1500); // pg_isready can answer during the init restart
console.log(`Postgres ready on 127.0.0.1:${port}; running the platform suite against it...`);
const res = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  cwd: new URL("../services/platform/", import.meta.url),
  stdio: "inherit", shell: true,
  env: { ...process.env, OPENPARTY_TEST_DATABASE_URL: `postgres://postgres:test@127.0.0.1:${port}/postgres` },
});
try { run("rm", "-f", name); } catch { /* already gone */ }
process.exit(res.status ?? 1);
