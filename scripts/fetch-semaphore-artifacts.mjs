#!/usr/bin/env node
// Downloads the Semaphore proving artifacts (circuit WebAssembly and proving key) for the tree depths we use, and CHECKS EACH FILE
// against a pinned SHA-256 before keeping it. They come from the Semaphore project's trusted-setup ceremony via the Privacy & Scaling
// Explorations snark-artifacts host; nothing is trusted on the strength of the host alone. If a hash does not match, the file is deleted
// and this script fails: either the host changed the files (investigate) or we are upgrading Semaphore (re-pin on purpose).
//
//   node scripts/fetch-semaphore-artifacts.mjs [depth ...]      default: 4 20   (4 for tests, 20 = up to about one million members)
//
// The files go to services/platform/semaphore-artifacts/ (git-ignored). The platform serves them to voters' browsers from there, so a
// voter never has to reach a third-party host, and the Docker image bakes them in at build time.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://snark-artifacts.pse.dev/semaphore/latest";
// Pinned for @semaphore-protocol/* 4.14.5. To add a depth: download it, review it, and add its two hashes here in the same commit.
const PINNED = {
  4: { wasm: "ec0ed0ae7eb0264070b36a247cf4aad8157c5550f0731d3462019526e5e9ae4f", zkey: "90c94bad7ad97eeb9314750e443d84da783e38a21f55538d72b10d258064f6e6" },
  20: { wasm: "6f71e55586929e520e76027ebe067daac8b41e2f4b8057313a5fd0304e1e44ee", zkey: "33f9a067a80c7daf90e085449073613a9559a1904dd40aeb6d603afb7988c2cc" },
};

const dir = process.env.SEMAPHORE_ARTIFACTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "services", "platform", "semaphore-artifacts");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const depths = (process.argv.slice(2).length ? process.argv.slice(2) : ["4", "20"]).map(Number);
mkdirSync(dir, { recursive: true });

let failed = false;
for (const d of depths) {
  const want = PINNED[d];
  if (!want) { console.error(`depth ${d} is not pinned in this script. Add its hashes after reviewing the files.`); failed = true; continue; }
  for (const ext of ["wasm", "zkey"]) {
    const file = join(dir, `semaphore-${d}.${ext}`);
    if (existsSync(file) && sha(readFileSync(file)) === want[ext]) continue;
    const res = await fetch(`${BASE}/semaphore-${d}.${ext}`);
    if (!res.ok) { console.error(`depth ${d} .${ext}: download failed (${res.status})`); failed = true; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== want[ext]) { console.error(`depth ${d} .${ext}: HASH MISMATCH (got ${sha(buf)}). Not saved.`); failed = true; continue; }
    writeFileSync(`${file}.part`, buf);
    rmSync(file, { force: true });
    renameSync(`${file}.part`, file);
    console.log(`depth ${d} .${ext}: ok (${buf.length} bytes, verified)`);
  }
}
process.exit(failed ? 1 : 0);
