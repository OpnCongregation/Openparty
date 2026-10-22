#!/usr/bin/env node
// Run before publishing the repository: `npm run prepublish:check` (add `-- --strict` to fail on open TODOs too).
// It looks for things that must never reach a public repository, and lists the blanks only a person can fill in.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "reports", "data", "dist", "coverage"]);
const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".docx", ".zip", ".gz", ".woff", ".woff2", ".pack", ".tsbuildinfo"]);

const rel = (f) => relative(root, f).replaceAll("\\", "/");

// A small .gitignore reader: plain names, `*` wildcards, a trailing "/" for directories and "!" exceptions.
// Ignored files are not uploaded, so they are not scanned (your local .env is expected to be among them).
const gitignore = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
const rules = gitignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((line) => {
  const neg = line.startsWith("!");
  const p = neg ? line.slice(1) : line;
  const dir = p.endsWith("/");
  const body = p.replace(/\/$/, "").replace(/^\//, "");
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return { neg, dir, anchored: body.includes("/"), re: new RegExp(`^${escaped}$`) };
});
function ignored(path) {
  const parts = path.split("/");
  let hit = false;
  for (const { neg, dir, anchored, re } of rules) {
    let m = false;
    for (let i = 0; i < parts.length && !m; i++) {
      if (dir && i === parts.length - 1) continue; // a directory rule matches only directories
      m = re.test(anchored ? parts.slice(0, i + 1).join("/") : parts[i]);
    }
    if (m) hit = !neg;
  }
  return hit;
}

const all = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); }
    else all.push(join(dir, e.name));
  }
})(root);
const files = all.filter((f) => !ignored(rel(f)));

const CONTACT_FILES = new Set(["SECURITY.md", "CODE_OF_CONDUCT.md"]);
const fails = [];
const todos = [];

// 1. The ignore rules that keep secrets out, and files that should never be uploaded.
for (const need of [".env", "node_modules", "reports"])
  if (!ignored(`${need}/x`) && !ignored(need)) fails.push(`.gitignore does not cover ${need}`);
for (const f of files) {
  const r = rel(f);
  if (/(^|\/)\.env(\.|$)/.test(r) && !r.endsWith(".env.example")) fails.push(`${r}: an environment file is in the upload set`);
  if (/\.(pem|key|p12|pfx)$/i.test(r) || /(^|\/)(log|witness)\.key$/.test(r)) fails.push(`${r}: key material`);
  if (/\.docx$/i.test(r)) fails.push(`${r}: a Word document (the product requirements are not part of the repository unless you decide so)`);
  if (statSync(f).size > 5 * 1024 * 1024) fails.push(`${r}: larger than 5 MB (a build artefact?)`);
}

// 2. Secrets and personal data inside text files.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\b(MASTER_KEY_HEX|PEPPER_HEX|APPEND_TOKEN|POSTGRES_PASSWORD)\s*[:=]\s*["']?[0-9A-Za-z+/=_-]{16,}/, "a real-looking secret value"],
  [/\bLOG_KEY\s*=\s*[0-9a-f]{64}\b/, "a LOG_KEY value (public, but it identifies a private deployment)"],
  [/\b[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|icloud|proton|protonmail)\.[a-z.]+\b/i, "a personal email address"],
  [/\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b|\bAKIA[0-9A-Z]{16}\b/, "an API token"],
];
for (const f of files) {
  const r = rel(f);
  if (BINARY.has(extname(f).toLowerCase()) || r.startsWith("scripts/prepublish-check")) continue; // the checker and its tests contain sample secrets on purpose
  const text = readFileSync(f, "utf8");
  for (const [re, what] of PATTERNS) {
    const m = re.exec(text);
    // A maintainer contact address is meant to be public, but only in the files that exist to publish it.
    if (m && what === "a personal email address" && CONTACT_FILES.has(r)) continue;
    if (m && !r.endsWith(".env.example")) fails.push(`${r}: ${what} ("${m[0].slice(0, 40)}...")`);
  }
  // 3. Blanks only a person can fill in.
  for (const line of text.split(/\r?\n/)) {
    if (/\[INSERT [A-Z ]+\]|\[MAINTAINERS:/.test(line)) { todos.push(`${r}: ${line.trim().slice(0, 110)}`); break; }
  }
}

// 4. Required community files.
for (const need of ["LICENSE", "LICENSE-DOCS", "NOTICE", "README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "GOVERNANCE.md", "CHANGELOG.md"])
  if (!existsSync(join(root, need))) fails.push(`${need}: missing`);
if (existsSync(join(root, "LICENSE")) && !/Apache License\s+Version 2\.0/.test(readFileSync(join(root, "LICENSE"), "utf8"))) fails.push("LICENSE: not the Apache-2.0 text");

// 5. The honesty labels must still be on the packs.
const ng = join(root, "packs", "ng", "v1", "pack.yaml");
if (existsSync(ng) && !/status:\s*draft/.test(readFileSync(ng, "utf8"))) todos.push("packs/ng/v1/pack.yaml: no longer marked draft. Has Nigerian counsel reviewed it?");

console.log(`Checked ${files.length} files that would be uploaded (${all.length - files.length} ignored by .gitignore, such as your local .env).`);
for (const f of fails) console.log(`FAIL  ${f}`);
for (const t of todos) console.log(`TODO  ${t}`);
if (!fails.length) console.log("No secrets, key material or personal data found in the upload set.");
if (todos.length) console.log(`${todos.length} item(s) need a person before publishing.`);
process.exit(fails.length || (strict && todos.length) ? 1 : 0);
