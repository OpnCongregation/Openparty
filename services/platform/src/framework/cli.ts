// Validate every law pack and party file in the repository: `npm run validate:packs`.
// Exit code 1 if anything is malformed or a party breaks its pack. Useful for law pack authors and in CI.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildConfig, ConfigError } from "./config.js";
import { findRoot, loadFloor, loadPack, loadParty } from "./load.js";

const root = findRoot();
const floor = loadFloor();
let failed = false;
const say = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed = true; };

say(true, `floor v${floor.version}: ${floor.rules.length} rules`);

const packs: { path: string; pack: ReturnType<typeof loadPack> }[] = [];
for (const dir of ["packs", join("packs", "_test")]) {
  const base = join(root, dir);
  if (!existsSync(base)) continue;
  for (const c of readdirSync(base, { withFileTypes: true })) {
    if (!c.isDirectory() || c.name === "_test") continue;
    const sub = join(base, c.name);
    for (const v of readdirSync(sub, { withFileTypes: true })) {
      const file = join(sub, v.name, "pack.yaml");
      const direct = join(sub, "pack.yaml");
      const f = v.isDirectory() && existsSync(file) ? file : v.name === "pack.yaml" ? direct : null;
      if (!f) continue;
      try {
        const pack = loadPack(f, floor);
        packs.push({ path: f, pack });
        say(true, `${f.replace(root, ".")}: ${pack.id} v${pack.version} (${pack.status}) ${pack.rules.length} rules, ${pack.signature}`);
      } catch (e: any) {
        say(false, `${f.replace(root, ".")}: ${e.message}`);
      }
    }
  }
}

const partyFiles: string[] = [];
for (const base of [join(root, "parties"), join(root, "packs", "_test")]) {
  if (!existsSync(base)) continue;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name === "settings.yaml" || e.name === "party.yaml") partyFiles.push(join(d, e.name));
    }
  };
  walk(base);
}
for (const f of partyFiles) {
  try {
    const party = loadParty(f);
    const hit = packs.find((p) => p.pack.id === party.pack.id && p.pack.version === party.pack.version);
    if (!hit) { say(false, `${f.replace(root, ".")}: no pack ${party.pack.id} v${party.pack.version} found`); continue; }
    buildConfig(floor, hit.pack, party);
    say(true, `${f.replace(root, ".")}: ${party.party} satisfies ${party.pack.id} v${party.pack.version}`);
  } catch (e: any) {
    say(false, `${f.replace(root, ".")}: ${e instanceof ConfigError ? e.message : e.message}`);
  }
}

process.exit(failed ? 1 : 0);
