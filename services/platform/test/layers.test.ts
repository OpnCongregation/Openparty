import { PGlite } from "@electric-sql/pglite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SimPayments, MemoryTrustLog, SimSms } from "../src/adapters.js";
import { DAY } from "../src/context.js";
import * as contests from "../src/contests.js";
import * as finance from "../src/finance.js";
import { buildServer } from "../src/server.js";
import { handleUssd } from "../src/ussd.js";
import { buildConfig, loadDefaultConfig } from "../src/framework/config.js";
import { recordDeployment } from "../src/framework/deploy.js";
import { findRoot, loadFloor, loadPack, loadParty } from "../src/framework/load.js";
import { createCtx } from "../src/platform.js";
import { SCHEMA } from "../src/schema.js";
import { setup, T0 } from "./helpers.js";
import { TestlandIdAdapter } from "./fixtures/tl-adapter.js";

const NGN = (n: number) => ({ ref: `r-${Math.random()}`, amountMinor: n * 100, currency: "NGN", country: "NG" });
const donor = { name: "Chief A", address: "1 Lagos Rd", occupation: "Trader" };

async function testland() {
  const root = findRoot();
  const floor = loadFloor();
  const pack = loadPack(join(root, "packs", "_test", "testland", "pack.yaml"), floor);
  const party = loadParty(join(root, "packs", "_test", "testland", "party.yaml"));
  const config = buildConfig(floor, pack, party);
  const state = { now: new Date(T0) };
  const log = new MemoryTrustLog();
  const sms = new SimSms();
  const ctx = await createCtx({ config, idAdapter: new TestlandIdAdapter(), payments: new SimPayments("TST", "TL"), log, sms, clock: () => new Date(state.now) });
  return { ctx, log, sms, state };
}

describe("same core, different law pack: Testland (synthetic)", () => {
  it("a 15-day notice is fine under Testland (14 days) and refused under Nigeria (21)", async () => {
    const t = await testland();
    const cid = await contests.createContest(t.ctx, { name: "T", primaryType: "direct", mode: "in_person", voteDate: new Date(T0.getTime() + 15 * DAY) });
    await expect(contests.generateNotice(t.ctx, cid)).resolves.toMatchObject({ mode: "in_person" });
    const ng = await setup();
    const c2 = await contests.createContest(ng.ctx, { name: "N", primaryType: "direct", mode: "virtual", voteDate: new Date(T0.getTime() + 15 * DAY) });
    await expect(contests.generateNotice(ng.ctx, c2)).rejects.toMatchObject({ code: "notice_late" });
  });
  it("modes and primary types come from the pack", async () => {
    const { ctx } = await testland();
    const d = new Date(T0.getTime() + 30 * DAY);
    await expect(contests.createContest(ctx, { name: "x", primaryType: "direct", mode: "virtual", voteDate: d })).rejects.toMatchObject({ code: "bad_mode" });
    await expect(contests.createContest(ctx, { name: "x", primaryType: "consensus", mode: "in_person", voteDate: d })).rejects.toMatchObject({ code: "bad_primary_type" });
  });
  it("the type lock is 5 days in Testland", async () => {
    const t = await testland();
    const cid = await contests.createContest(t.ctx, { name: "L", primaryType: "direct", mode: "in_person", voteDate: new Date(T0.getTime() + 30 * DAY) });
    t.state.now = new Date(T0.getTime() + 24 * DAY); // T-6
    await expect(contests.changePrimaryType(t.ctx, cid, "direct")).resolves.toBeUndefined();
    t.state.now = new Date(T0.getTime() + 25 * DAY); // T-5
    await expect(contests.changePrimaryType(t.ctx, cid, "direct")).rejects.toMatchObject({ code: "type_locked" });
  });
  it("money: the pack's own currency is accepted and Nigerian naira is quarantined", async () => {
    const { ctx } = await testland();
    await expect(finance.recordGift(ctx, { ref: "a", amountMinor: 100_000, currency: "TST", country: "TL" }, donor)).resolves.toBeDefined();
    await expect(finance.recordGift(ctx, { ref: "b", amountMinor: 100_000, currency: "NGN", country: "NG" }, donor)).rejects.toMatchObject({ code: "foreign_funds" });
    // the pack's ceiling is 5,000.00 TST and the party tightened it to 4,000.00: 1,000 given, 3,500 more would pass 4,000
    await expect(finance.recordGift(ctx, { ref: "c", amountMinor: 350_000, currency: "TST", country: "TL" }, donor)).rejects.toMatchObject({ code: "over_cap" });
  });
  it("registration uses a different ID system, a different field list and different words", async () => {
    const t = await testland();
    expect(await handleUssd(t.ctx, "+2000000001", "1")).toMatch(/national ID number/);
    expect(await handleUssd(t.ctx, "+2000000001", "1*TL123456")).toMatch(/TES/);
    expect(await handleUssd(t.ctx, "+2000000001", "1*TL123456*1")).toMatch(/Testland Electoral Board/);
    const end = await handleUssd(t.ctx, "+2000000001", "1*TL123456*1*2*1234*1234");
    expect(end).toMatch(/^END You have joined/);
    expect(await handleUssd(t.ctx, "+2000000001", "2*1234")).toMatch(/Amount in TST/);
    expect(await handleUssd(t.ctx, "+2000000001", "2*1234*50")).toMatch(/Minimum dues is 10000 cent/); // the party-level default minimum is 100.00
    expect(await handleUssd(t.ctx, "+2000000001", "2*1234*150")).toMatch(/Dues of T\$150/);
    // an NIN is not an id here
    expect(await handleUssd(t.ctx, "+2000000002", "1*12345678901")).toMatch(/could not be verified/);
  });
});

describe("tighten, never loosen, at run time", () => {
  it("a party can lower the donor cap but not raise it above the law, and the refusal cites the rule", async () => {
    const { ctx } = await setup();
    await expect(contests.setRule(ctx, "finance.cap_per_donor_minor", 500_000_000, "sec")).resolves.toBeUndefined();
    await expect(contests.setRule(ctx, "finance.cap_per_donor_minor", 50_000_000_001, "sec")).rejects.toMatchObject({ code: "invalid_rule", message: expect.stringMatching(/NG-FIN-02/) });
  });
  it("only editable rules can be changed at run time; legal parameters cannot", async () => {
    const { ctx } = await setup();
    for (const k of ["notice.days_before_contest", "finance.anonymous_gifts_allowed", "eligibility.party_criteria_allowed", "made.up"])
      await expect(contests.setRule(ctx, k, 1, "sec")).rejects.toMatchObject({ code: "unknown_rule" });
  });
  it("the contest notice commits to the three layers, not just the editable rules", async () => {
    const a = await setup();
    const b = await testland();
    expect(await contests.rulesHash(a.ctx)).not.toBe(await contests.rulesHash(b.ctx));
  });
});

describe("DDPN: donor cap is per rolling year", () => {
  it("N6m then N5m is refused; a year later N5m is accepted", async () => {
    const { ctx, advance } = await setup();
    await finance.recordGift(ctx, NGN(6_000_000), donor);
    await expect(finance.recordGift(ctx, NGN(5_000_000), donor)).rejects.toMatchObject({ code: "over_cap" });
    advance(366);
    await expect(finance.recordGift(ctx, NGN(5_000_000), donor)).resolves.toBeDefined();
  });
  it("with no window (lifetime cap) the old gift still counts", async () => {
    const c = loadDefaultConfig();
    const party = { ...c.party, settings: { ...c.party.settings } };
    delete (party.settings as any)["finance.cap_window_days"];
    const config = buildConfig(c.floor, c.pack, party);
    const state = { now: new Date(T0) };
    const ctx = await createCtx({ config, log: new MemoryTrustLog(), clock: () => new Date(state.now) });
    await finance.recordGift(ctx, NGN(6_000_000), donor);
    state.now = new Date(T0.getTime() + 400 * DAY);
    await expect(finance.recordGift(ctx, NGN(5_000_000), donor)).rejects.toMatchObject({ code: "over_cap" });
  });
});

describe("configuration fingerprint on the public log", () => {
  it("is recorded once, posted to the log, and changes when any layer changes", async () => {
    const { ctx, log } = await setup();
    const first = await recordDeployment(ctx);
    expect(first.changed).toBe(true);
    expect((await recordDeployment(ctx)).changed).toBe(false);
    const ev = log.events.filter((e) => e.type === "deployment.configured");
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ fingerprint: ctx.config.fingerprint, pack_id: "NG", floor_version: "1.0" });
    expect(JSON.stringify(ev[0].data)).not.toMatch(/DDPN|Godfather/); // identifiers and hashes only, no profile text

    const c = ctx.config;
    const tightened = buildConfig(c.floor, c.pack, { ...c.party, hash: "different", settings: { ...c.party.settings, "notice.days_before_contest": 30 } });
    expect(tightened.fingerprint).not.toBe(c.fingerprint);
    await expect(ctx.db.query("UPDATE deployment_config SET party='x'")).rejects.toThrow(/immutable/);
  });
});

describe("database migration from the Nigeria-only names", () => {
  const OLD = `
    CREATE TABLE members (id TEXT PRIMARY KEY, nin_hash TEXT NOT NULL UNIQUE, phone_hash TEXT, state TEXT NOT NULL, card_no TEXT UNIQUE,
      pin_hash TEXT, pin_failures INT NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'anonymous', record_enc TEXT, ward TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), activated_at TIMESTAMPTZ, activated_by TEXT);
    CREATE TABLE finance_ledger (id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, amount_kobo BIGINT NOT NULL, member_id TEXT, donor_key TEXT,
      donor_enc TEXT, contest_id TEXT, external_ref TEXT UNIQUE, at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE quarantine (id BIGSERIAL PRIMARY KEY, reason TEXT NOT NULL, amount_kobo BIGINT, external_ref TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO members(id,nin_hash,state) VALUES ('m1','h1','provisional');
    INSERT INTO finance_ledger(kind,amount_kobo,external_ref) VALUES ('dues',12345,'ref1');`;
  const cols = async (db: PGlite, t: string) =>
    (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name=$1", [t])).rows.map((r) => r.column_name);

  it("renames columns in place, keeps the data, and is safe to run again", async () => {
    const db = new PGlite();
    await db.exec(OLD);
    await db.exec(SCHEMA);
    await db.exec(SCHEMA);
    expect(await cols(db, "members")).toContain("id_hash");
    expect(await cols(db, "members")).not.toContain("nin_hash");
    expect(await cols(db, "finance_ledger")).toContain("amount_minor");
    expect(await cols(db, "quarantine")).toContain("amount_minor");
    expect((await db.query<{ a: string }>("SELECT amount_minor::text AS a FROM finance_ledger")).rows[0].a).toBe("12345");
    expect((await db.query<{ h: string }>("SELECT id_hash AS h FROM members")).rows[0].h).toBe("h1");
  });
  it("a fresh database can run the schema twice", async () => {
    const db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(SCHEMA);
    expect(await cols(db, "members")).toContain("id_hash");
  });
});

describe("HTTP: /framework", () => {
  it("shows the layers, an honest self-assessment, and the party's settings", async () => {
    const { ctx } = await setup();
    const app = buildServer(ctx);
    const r = await app.inject({ method: "GET", url: "/framework" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.layers.pack).toMatchObject({ id: "NG", status: "draft", signature: "unsigned" });
    expect(b.notice).toMatch(/not a certification/);
    expect(b.fingerprint).toBe(ctx.config.fingerprint);
    expect(b.party.profile.acronym).toBe("DDPN");
    expect(b.registry.deployments[0].status).toBe("planned");
    expect(JSON.stringify(b)).not.toMatch(/pepper|MASTER_KEY/i);
  });
  it("/framework/check says yes or no and names the rule", async () => {
    const { ctx } = await setup();
    const app = buildServer(ctx);
    const yes = (await app.inject({ method: "GET", url: "/framework/check?param=notice.days_before_contest&value=30" })).json();
    expect(yes).toMatchObject({ accepted: true, known: true });
    const no = (await app.inject({ method: "GET", url: "/framework/check?param=notice.days_before_contest&value=10" })).json();
    expect(no.accepted).toBe(false);
    expect(no.violations[0]).toMatchObject({ rule: "NG-NOT-01" });
    const unknown = (await app.inject({ method: "GET", url: "/framework/check?param=nope&value=1" })).json();
    expect(unknown).toMatchObject({ accepted: false, known: false });
    expect((await app.inject({ method: "GET", url: "/framework/check" })).statusCode).toBe(400);
  });
});
