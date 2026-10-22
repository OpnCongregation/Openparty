import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "prepublish-check.mjs");

/** Build a tiny repository around a copy of the script and run the check in it. */
function check(files, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "op-prepub-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(script, join(dir, "scripts", "prepublish-check.mjs"));
    const base = {
      LICENSE: "Apache License\n Version 2.0, January 2004", "LICENSE-DOCS": "x", NOTICE: "x", "README.md": "x", "CONTRIBUTING.md": "x",
      "CODE_OF_CONDUCT.md": "x", "SECURITY.md": "x", "GOVERNANCE.md": "x", "CHANGELOG.md": "x",
      ".gitignore": ".env\nnode_modules/\nreports/\n*.exe\n",
    };
    for (const [name, text] of Object.entries({ ...base, ...files })) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const r = spawnSync("node", [join(dir, "scripts", "prepublish-check.mjs"), ...extra], { encoding: "utf8" });
    return { code: r.status, out: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a clean tree passes, and a git-ignored local .env is not a problem", () => {
  const r = check({ ".env": "POSTGRES_PASSWORD=abcdefghijklmnopqrstuvwxyz123456\n", "a.txt": "hello" });
  assert.equal(r.code, 0, r.out);
});

test("a private key block fails", () => {
  const r = check({ "k.txt": "-----BEGIN PRIVATE KEY-----\nabc\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /private key/);
});

test("a secret value in a tracked file fails, but the .env.example placeholder does not", () => {
  assert.equal(check({ "docs.md": "MASTER_KEY_HEX=0123456789abcdef0123456789abcdef" }).code, 1);
  assert.equal(check({ ".env.example": "MASTER_KEY_HEX=\nPOSTGRES_PASSWORD=change-me\n" }).code, 0);
});

test("a personal email address fails", () => {
  const r = check({ "a.md": "contact someone@gmail.com" });
  assert.equal(r.code, 1);
  assert.match(r.out, /personal email/);
});

test("an .env that is NOT git-ignored fails, and so does a missing ignore rule", () => {
  const r = check({ ".gitignore": "node_modules/\nreports/\n", ".env": "X=1\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /\.gitignore does not cover \.env/);
});

test("a Word document fails", () => {
  assert.equal(check({ "OpenParty_PRD.docx": "x" }).code, 1);
});

test("open placeholders are listed, and fail only in --strict mode", () => {
  const files = { "SECURITY.md": "[MAINTAINERS: add a contact]" };
  const lax = check(files);
  assert.equal(lax.code, 0);
  assert.match(lax.out, /TODO\s+SECURITY\.md/);
  assert.equal(check(files, ["--strict"]).code, 1);
});

test("a missing licence file fails", () => {
  assert.equal(check({ LICENSE: "MIT" }).code, 1);
});

test("a maintainer contact email is allowed in SECURITY.md and CODE_OF_CONDUCT.md only", () => {
  assert.equal(check({ "SECURITY.md": "email maintainer@gmail.com" }).code, 0);
  assert.equal(check({ "CODE_OF_CONDUCT.md": "email maintainer@gmail.com" }).code, 0);
  assert.equal(check({ "README.md": "email maintainer@gmail.com" }).code, 1);
});
