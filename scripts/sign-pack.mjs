#!/usr/bin/env node
// Foundation tool: sign a law pack with an ed25519 key, producing <pack>.sig (hex).
//   node scripts/sign-pack.mjs keygen                  prints a new private key (seed) and its public key
//   node scripts/sign-pack.mjs sign <pack.yaml> <seed-hex>
// A deployment verifies the signature when FOUNDATION_PUBKEY (the public key, hex) is set. Unsigned packs are reported as unsigned.
// Keep the seed offline. No foundation key exists yet; the bundled packs are unsigned drafts.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const YAML = require(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "yaml"));

const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
      : JSON.stringify(v);

const [cmd, file, seedHex] = process.argv.slice(2);

if (cmd === "keygen") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  console.log(`private seed (keep offline): ${seed}\npublic key (FOUNDATION_PUBKEY): ${pub}`);
} else if (cmd === "sign" && file && seedHex) {
  const hash = createHash("sha256").update(canonical(YAML.parse(readFileSync(file, "utf8")))).digest("hex");
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  writeFileSync(`${file}.sig`, sign(null, Buffer.from(hash), key).toString("hex") + "\n");
  console.log(`signed ${file} (pack hash ${hash}) -> ${file}.sig`);
} else {
  console.error("usage: sign-pack.mjs keygen | sign <pack.yaml> <seed-hex>");
  process.exit(2);
}
