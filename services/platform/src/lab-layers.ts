import { join } from "node:path";
import { MemoryTrustLog, SimPayments, SimSms } from "./adapters.js";
import { DAY, type Ctx } from "./context.js";
import * as contests from "./contests.js";
import { buildConfig } from "./framework/config.js";
import { recordDeployment } from "./framework/deploy.js";
import { findRoot, loadFloor, loadPack, loadParty } from "./framework/load.js";
import { checkSetting } from "./framework/resolve.js";
import { createCtx } from "./platform.js";

/**
 * Lab scenarios for the three-layer design. They are described here and registered in lab.ts. A scenario only needs
 * the small `Steps` surface below, so this file does not depend on the runner's internals.
 */
export interface Steps {
  ctx: Ctx;
  log: MemoryTrustLog;
  at(days: number): Date;
  ok(title: string, law: string | undefined, fn: () => Promise<unknown>): Promise<void>;
  blocked(title: string, law: string | undefined, expect: string | RegExp, fn: () => Promise<unknown>): Promise<void>;
}

export interface LayerScenario { id: string; title: string; law: string; blurb: string; run: (r: Steps) => Promise<void> }

const refuse = (problems: { rule: string; message: string }[]) => {
  if (problems.length) throw Object.assign(new Error(problems.map((p) => `[${p.rule}] ${p.message}`).join("; ")), { code: problems[0].rule });
};

async function testlandCtx(): Promise<Ctx> {
  const root = findRoot();
  const floor = loadFloor();
  const pack = loadPack(join(root, "packs", "_test", "testland", "pack.yaml"), floor);
  const party = loadParty(join(root, "packs", "_test", "testland", "party.yaml"));
  const { TestlandAdapter } = await import("./lab-testland.js");
  return createCtx({ config: buildConfig(floor, pack, party), idAdapter: new TestlandAdapter(), payments: new SimPayments("TST", "TL"), log: new MemoryTrustLog(), sms: new SimSms() });
}

export const LAYER_SCENARIOS: LayerScenario[] = [
  {
    id: "tighten-only", title: "A party can tighten the law, never loosen it", law: "Three-layer rule; NG-NOT-01, NG-FIN-02",
    blurb: "Party settings are checked against the country law pack before they save. A stricter value passes. A looser one is refused with the rule and its citation.",
    async run(r) {
      const pack = r.ctx.config.pack;
      await r.ok("The pack requires 21 days' notice. The party asks for 30.", "NG-NOT-01", async () => {
        refuse(checkSetting(pack, "notice.days_before_contest", 30));
        return "Accepted: 30 is stricter than 21.";
      });
      await r.blocked("The party asks for 10 days' notice", "NG-NOT-01", /NG-NOT-01/, async () => refuse(checkSetting(pack, "notice.days_before_contest", 10)));
      await r.ok("The law caps a donor at N500m. The party sets N10m.", "NG-FIN-02", async () => {
        refuse(checkSetting(pack, "finance.cap_per_donor_minor", 1_000_000_000));
        return "Accepted: well below the legal ceiling. (This is the DDPN sample setting.)";
      });
      await r.blocked("The party tries to raise the cap to N600m", "NG-FIN-02", /NG-FIN-02/, async () => refuse(checkSetting(pack, "finance.cap_per_donor_minor", 60_000_000_000)));
      await r.blocked("The party tries to allow anonymous gifts", "NG-FIN-01", /NG-FIN-01/, async () => refuse(checkSetting(pack, "finance.anonymous_gifts_allowed", true)));
      await r.blocked("The party tries to add a primary type the law does not allow", "NG-PRI-01", /NG-PRI-01/, async () => refuse(checkSetting(pack, "primary.allowed_types", ["direct", "delegate"])));
      await r.blocked("The same limit applies while the party is running: raise the live donor cap above the law", "NG-FIN-02", "invalid_rule", () =>
        contests.setRule(r.ctx, "finance.cap_per_donor_minor", 60_000_000_000, "secretary"));
    },
  },
  {
    id: "law-switches-off", title: "Where the law forbids a feature, the pack switches it off", law: "s.85, Reg 25(1); NG-ELIG-01",
    blurb: "The one exception to \"higher layers only tighten\": national law may remove a feature. Screening, covenant and ratings stay advisory, and no party setting can turn that back on.",
    async run(r) {
      const pack = r.ctx.config.pack;
      await r.ok("What the pack switches off", "NG-ELIG-01", async () =>
        pack.featuresOff.map((f) => `${f.key}: ${f.effect} (${f.source})`).join(" | ") || (() => { throw new Error("nothing switched off"); })());
      await r.blocked("A party tries to allow its own criteria for who may stand", "NG-ELIG-01", /NG-ELIG-01/, async () =>
        refuse(checkSetting(pack, "eligibility.party_criteria_allowed", true)));
      await r.blocked("A party tries to let ratings affect eligibility", "Ratings are advice", /effect_on_eligibility/, async () =>
        refuse(checkSetting(pack, "ratings.effect_on_eligibility", "blocks_candidacy")));
      for (const k of ["min_membership_months", "aspirant_exam_score", "covenant_score_min", "min_rating"])
        await r.blocked(`A runtime rule called ${k}`, "s.85: no extra criteria", "unknown_rule", () => contests.setRule(r.ctx, k, 1, "secretary"));
      await r.blocked("A party tries to create a security group", "NG-SAF-01, floor F11", /NG-SAF-01/, async () =>
        refuse(checkSetting(pack, "safety.security_group_allowed", true)));
    },
  },
  {
    id: "fingerprint", title: "The rules a deployment runs under are fingerprinted on the public log", law: "PRD sections 11 and 18",
    blurb: "Floor version, law pack and party settings are hashed into one fingerprint and posted to the public log, so anyone can see when a deployment's rules changed.",
    async run(r) {
      const c = r.ctx.config;
      await r.ok("Start the deployment", undefined, async () => {
        const d = await recordDeployment(r.ctx);
        return `Fingerprint ${d.fingerprint.slice(0, 16)}… recorded: floor v${c.floor.version}, law pack ${c.pack.id} v${c.pack.version} (${c.pack.status}, ${c.pack.signature}), party ${c.party.party}.`;
      });
      await r.ok("Restart with nothing changed", undefined, async () => {
        const d = await recordDeployment(r.ctx);
        if (d.changed) throw new Error("recorded twice");
        return "Nothing new to record; the log is not spammed.";
      });
      await r.ok("The public log carries identifiers and a hash, not settings text", "Pseudonymous log", async () => {
        const ev = r.log.events.filter((e) => e.type === "deployment.configured");
        if (ev.length !== 1) throw new Error(`${ev.length} events`);
        return JSON.stringify(ev[0].data);
      });
      await r.ok("The party tightens the notice period and restarts", undefined, async () => {
        const c2 = buildConfig(c.floor, c.pack, { ...c.party, hash: `${c.party.hash}-v2`, settings: { ...c.party.settings, "notice.days_before_contest": 30 } });
        if (c2.fingerprint === c.fingerprint) throw new Error("fingerprint did not change");
        return `New fingerprint ${c2.fingerprint.slice(0, 16)}…: any change to any layer shows up on the log.`;
      });
    },
  },
  {
    id: "same-core", title: "Same core, different country", law: "Universal core + law pack",
    blurb: "Run the same code on the synthetic, fictional \"Testland\" pack. A 15-day notice is lawful there (14 days) but refused under Nigeria's 21. No Nigerian number is hard-coded.",
    async run(r) {
      const other = await testlandCtx();
      try {
        const nigeria = r.ctx.config.pack;
        const tl = other.config.pack;
        await r.ok("Compare the two packs", undefined, async () =>
          `${nigeria.name}: notice ${nigeria.params["notice.days_before_contest"]} days, ${nigeria.currency.code}, modes ${JSON.stringify(nigeria.params["notice.modes"])}. ` +
          `${tl.name}: notice ${tl.params["notice.days_before_contest"]} days, ${tl.currency.code}, modes ${JSON.stringify(tl.params["notice.modes"])}.`);
        const nid = await contests.createContest(r.ctx, { name: "Nigeria 15d", primaryType: "direct", mode: "virtual", voteDate: r.at(15) });
        await r.blocked("Nigeria: a notice for a vote 15 days away", "NG-NOT-01", "notice_late", () => contests.generateNotice(r.ctx, nid));
        const tid = await contests.createContest(other, { name: "Testland 15d", primaryType: "direct", mode: "in_person", voteDate: new Date(Date.now() + 15 * DAY) });
        await r.ok("Testland: the same notice for a vote 15 days away", "TL-NOT-01 (fictional)", async () => {
          await contests.generateNotice(other, tid);
          return "Accepted: the fictional law needs only 14 days.";
        });
        await r.blocked("Testland: a virtual vote", "TL-NOT-01 (fictional)", "bad_mode", () =>
          contests.createContest(other, { name: "x", primaryType: "direct", mode: "virtual", voteDate: new Date(Date.now() + 30 * DAY) }));
        await r.blocked("Testland: a consensus primary", "TL-PRI-01 (fictional)", "bad_primary_type", () =>
          contests.createContest(other, { name: "x", primaryType: "consensus", mode: "in_person", voteDate: new Date(Date.now() + 30 * DAY) }));
      } finally {
        await other.db.close();
      }
    },
  },
];
