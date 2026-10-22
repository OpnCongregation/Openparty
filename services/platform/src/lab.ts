import { readFile } from "node:fs/promises";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createCtx } from "./platform.js";
import { MemoryTrustLog, SimSms } from "./adapters.js";
import { approve, propose, registerAdmin, signingString, type Role } from "./admin.js";
import { DAY, type Ctx } from "./context.js";
import { DomainError } from "./errors.js";
import * as contests from "./contests.js";
import * as finance from "./finance.js";
import * as members from "./members.js";
import * as participation from "./participation.js";
import { buildServer } from "./server.js";
import { handleUssd } from "./ussd.js";
import { LAYER_SCENARIOS } from "./lab-layers.js";

/**
 * Lab: runs the core rules as visible, step-by-step scenarios.
 * Every run builds a throwaway sandbox (embedded Postgres, in-memory log, virtual clock) and discards it,
 * so it never touches the real database or the public log. Off unless LAB_ENABLED=1.
 */

const T0 = new Date("2026-11-01T09:00:00Z");
const NGN = (n: number) => ({ ref: `r-${randomUUID()}`, amountMinor: n * 100, currency: "NGN", country: "NG" });
const donor = { name: "Chief A", address: "1 Lagos Rd", occupation: "Trader" };

export interface StepState {
  members: Record<string, number>;
  contests: { name: string; state: string }[];
  ledgerNaira: number;
  logSize: number;
}
export interface Step {
  n: number;
  kind: "allowed" | "blocked" | "time" | "fail";
  title: string;
  law?: string;
  detail: string;
  code?: string;
  day: number;
  logAdded: { type: string; data: unknown }[];
  state: StepState;
}

class Run {
  steps: Step[] = [];
  failed = false;
  private seen = 0;
  private nin = 10_000_000_000;
  constructor(readonly ctx: Ctx, readonly log: MemoryTrustLog, readonly sms: SimSms, private clock: { now: Date }) {}

  get now() { return new Date(this.clock.now); }
  at(days: number) { return new Date(this.clock.now.getTime() + days * DAY); }
  freshNin() { return String(++this.nin); }

  async admin(role: Role, ward?: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const id = await registerAdmin(this.ctx, { name: `${role}-${randomUUID().slice(0, 4)}`, role, ward, publicKeyHex: raw });
    const headers = (method: string, path: string, body = "") => {
      const ts = String(this.clock.now.getTime());
      const sig = sign(null, Buffer.from(signingString(ts, method, path, body)), privateKey).toString("hex");
      return { "x-admin-id": id, "x-timestamp": ts, "x-signature": sig };
    };
    return { id, name: role, role, ward: ward ?? null, headers };
  }

  /** Join through the USSD code path, then activate through a ward agent. Not recorded as a step. */
  async member(agent: { id: string; role: string; ward: string | null }) {
    const nin = this.freshNin();
    const phone = `+23480${nin.slice(-8)}`;
    await members.prepareJoin(this.ctx, phone, nin);
    const j = await members.confirmJoin(this.ctx, phone, "anonymous", "1234");
    await members.activateMember(this.ctx, agent, { memberId: j.memberId, ward: agent.ward!, pollingUnit: "PU-001", photoRef: "photo-1", disabilityStatus: "none" });
    return { ...j, phone, nin };
  }

  private async snap(): Promise<StepState> {
    const q = this.ctx.db.query.bind(this.ctx.db);
    const ms = await q<{ state: string; n: number }>("SELECT state, COUNT(*)::int AS n FROM members GROUP BY state");
    const cs = await q<{ name: string; state: string }>("SELECT name, state FROM contests ORDER BY vote_date");
    const l = await q<{ t: string | null }>("SELECT COALESCE(SUM(amount_minor),0)::text AS t FROM finance_ledger");
    return { members: Object.fromEntries(ms.map((m) => [m.state, m.n])), contests: cs, ledgerNaira: Number(l[0].t) / 100, logSize: this.log.events.length };
  }

  private async push(kind: Step["kind"], title: string, law: string | undefined, detail: string, code?: string) {
    const logAdded = this.log.events.slice(this.seen).map((e) => ({ type: e.type, data: e.data }));
    this.seen = this.log.events.length;
    if (kind === "fail") this.failed = true;
    this.steps.push({
      n: this.steps.length + 1, kind, title, law, detail, code, logAdded,
      day: Math.round((this.clock.now.getTime() - T0.getTime()) / DAY), state: await this.snap(),
    });
  }

  /** A step that should succeed. fn may return a string describing the result. */
  async ok(title: string, law: string | undefined, fn: () => Promise<unknown>) {
    if (this.failed) return;
    try {
      const r = await fn();
      await this.push("allowed", title, law, typeof r === "string" ? r : "Accepted.");
    } catch (e: any) {
      await this.push("fail", title, law, `Expected this to succeed, but: ${e.code ?? ""} ${e.message}`.trim());
    }
  }

  /** A step the system must refuse. `expect` matches the error code or message. */
  async blocked(title: string, law: string | undefined, expect: string | RegExp, fn: () => Promise<unknown>) {
    if (this.failed) return;
    try {
      await fn();
      await this.push("fail", title, law, "Expected a refusal, but the system allowed it.");
    } catch (e: any) {
      const code = e instanceof DomainError ? e.code : undefined;
      const hit = expect instanceof RegExp ? expect.test(`${code} ${e.message}`) : code === expect;
      await this.push(hit ? "blocked" : "fail", title, law,
        hit ? `Refused: ${e.message}` : `Refused for the wrong reason (${code ?? "error"}): ${e.message}`, code);
    }
  }

  async advance(days: number, why: string) {
    if (this.failed) return;
    this.clock.now = this.at(days);
    await this.push("time", `${why}`, undefined, `Virtual clock moves ${days} day${days === 1 ? "" : "s"} forward.`);
  }
}

interface Scenario { id: string; title: string; law: string; blurb: string; run: (r: Run) => Promise<void> }

const contestIn = (r: Run, days: number, name = "Primary") =>
  contests.createContest(r.ctx, { name, primaryType: "direct", mode: "virtual", voteDate: r.at(days) });

/** Drive a contest through every legal gate to a close, so later rules (unlock, erasure) can be shown. */
async function runCourse(r: Run, cid: string, needNotice: boolean) {
  if (needNotice) await contests.generateNotice(r.ctx, cid);
  await contests.recordNoticeReceipt(r.ctx, cid, "INEC-N-auto");
  const reg = await r.ctx.db.query<{ id: string }>("SELECT id FROM registers WHERE contest_id=$1", [cid]);
  const regId = reg.length ? reg[0].id : (await contests.freezeRegister(r.ctx, cid)).registerId;
  await contests.recordRegisterReceipt(r.ctx, regId, "INEC-R-auto");
  await contests.openContest(r.ctx, cid);
  await contests.closeContest(r.ctx, cid);
}

export const SCENARIOS: Scenario[] = [
  {
    id: "one-nin", title: "One NIN, one member", law: "Infiltration wave; s.77(2)",
    blurb: "A person can join once. A second sign-up on the same NIN, or an unverifiable NIN, is refused.",
    async run(r) {
      const nin = r.freshNin();
      await r.ok("Musa joins with his NIN", "s.77(2)", async () => {
        await members.prepareJoin(r.ctx, "+2348000000001", nin);
        const j = await members.confirmJoin(r.ctx, "+2348000000001", "anonymous", "1234");
        return `Joined as provisional member, card ${j.cardNo}.`;
      });
      await r.blocked("Someone else tries the same NIN", "One NIN one member", "id_in_use", () => members.prepareJoin(r.ctx, "+2348000000002", nin));
      await r.blocked("A NIN that cannot be verified", "NIN check", "id_invalid", () => members.prepareJoin(r.ctx, "+2348000000003", "00000000000"));
    },
  },
  {
    id: "membership", title: "Joining, activation and PIN lockout", law: "s.77(2), s.77(3)",
    blurb: "Only the member's own ward agent can activate, every register field is required, and five wrong PINs lock the account.",
    async run(r) {
      const w1 = await r.admin("ward_agent", "W1");
      const sec = await r.admin("secretary");
      let memberId = "", phone = "+2348000000010";
      await r.ok("Aisha joins (provisional member, card issued)", "s.77(3)", async () => {
        await members.prepareJoin(r.ctx, phone, r.freshNin());
        const j = await members.confirmJoin(r.ctx, phone, "visible", "1234");
        memberId = j.memberId;
        return `Card ${j.cardNo}. Not yet a full member.`;
      });
      const input = { memberId: "", ward: "W2", pollingUnit: "PU-001", photoRef: "p", disabilityStatus: "none" };
      await r.blocked("A ward agent from another ward tries to activate her", "Ward agent scope", "wrong_ward", () => members.activateMember(r.ctx, w1, { ...input, memberId }));
      await r.blocked("The secretary tries to activate her", "Roles", "forbidden", () => members.activateMember(r.ctx, sec, { ...input, memberId, ward: "W1" }));
      await r.blocked("Activation without a polling unit", "s.77(2) every field", "incomplete_record", () => members.activateMember(r.ctx, w1, { ...input, memberId, ward: "W1", pollingUnit: "" }));
      await r.ok("Her own ward agent activates her with a full record", "s.77(2)", async () => {
        await members.activateMember(r.ctx, w1, { ...input, memberId, ward: "W1" });
        return "Now an active member.";
      });
      for (let i = 1; i <= 5; i++) await r.blocked(`Wrong PIN, attempt ${i}`, "PIN lockout", "pin_wrong", () => members.verifyPin(r.ctx, phone, "9999"));
      await r.blocked("Correct PIN after five failures", "PIN lockout", "pin_locked", () => members.verifyPin(r.ctx, phone, "1234"));
    },
  },
  {
    id: "notice-timeline", title: "Notice, timing and primary-type lock", law: "s.82(1), Reg 22(1), Reg 24(3), Reg 10(2)",
    blurb: "A notice needs 21 days. The primary type can change until 4 days out and is locked from 3 days. Every contest has a mode.",
    async run(r) {
      await r.blocked("Create a contest with no mode", "Reg 10(2)", "mode_required", () =>
        contests.createContest(r.ctx, { name: "x", primaryType: "direct", mode: undefined as any, voteDate: r.at(30) }));
      let late = "", ok = "";
      await r.ok("Create a contest 20 days out and one 22 days out", undefined, async () => {
        late = await contestIn(r, 20, "Late"); ok = await contestIn(r, 22, "OnTime"); return "Two contests created.";
      });
      await r.blocked("Issue the 20-day notice", "s.82(1): 21 days' notice", "notice_late", () => contests.generateNotice(r.ctx, late));
      await r.ok("Issue the 22-day notice", "s.82(1)", async () => { await contests.generateNotice(r.ctx, ok); return "Notice issued; rules are now locked."; });
      let typed = "";
      await r.ok("Create a contest 30 days out", undefined, async () => { typed = await contestIn(r, 30, "TypeLock"); return "Created as a direct primary."; });
      await r.advance(26, "26 days pass (4 days before the vote)");
      await r.ok("Switch it to consensus at T-4", "Reg 24(3)", async () => { await contests.changePrimaryType(r.ctx, typed, "consensus"); return "Allowed."; });
      await r.advance(1, "One more day (3 days before the vote)");
      await r.blocked("Switch it back at T-3", "Reg 24(3)", "type_locked", () => contests.changePrimaryType(r.ctx, typed, "direct"));
    },
  },
  {
    id: "contest-gate", title: "A contest cannot open without INEC paperwork", law: "s.77(4)-(7), s.82(6), Reg 4(3)-(6)",
    blurb: "Voting stays locked until the notice receipt, the frozen register and the register receipt all exist.",
    async run(r) {
      const agent = await r.admin("ward_agent", "W1");
      await r.ok("Two members join and are activated", "s.77", async () => { await r.member(agent); await r.member(agent); return "Two active members."; });
      const cid = await contestIn(r, 40);
      await r.ok("Generate the notice", "s.82(1)", async () => { await contests.generateNotice(r.ctx, cid); return "Notice issued."; });
      await r.blocked("Try to open voting", "s.82(6)", "no_notice_receipt", () => contests.openContest(r.ctx, cid));
      await r.ok("Record INEC's notice receipt", "s.82(6)", async () => { await contests.recordNoticeReceipt(r.ctx, cid, "INEC-N-1"); return "Receipt stored."; });
      await r.blocked("Try to open voting", "s.77(4)", "no_register", () => contests.openContest(r.ctx, cid));
      let regId = "";
      await r.ok("Freeze the register", "s.77(4)", async () => {
        const f = await contests.freezeRegister(r.ctx, cid); regId = f.registerId;
        return `Frozen with ${f.memberCount} members. Fingerprint ${f.fingerprint.slice(0, 16)}â€¦ is on the public log.`;
      });
      await r.blocked("Try to open voting", "s.77(5)", "no_register_receipt", () => contests.openContest(r.ctx, cid));
      await r.ok("Record INEC's register receipt", "s.77(5)", async () => { await contests.recordRegisterReceipt(r.ctx, regId, "INEC-R-1"); return "Receipt stored."; });
      await r.ok("Open voting", "s.77(6)", async () => { await contests.openContest(r.ctx, cid); return "Contest is open."; });
    },
  },
  {
    id: "register-freeze", title: "Register freeze and tamper detection", law: "s.77(4)-(7), Reg 4",
    blurb: "The register freezes 21 days out, is a snapshot, exports only the legal fields, and any edit to it afterwards is detected.",
    async run(r) {
      const agent = await r.admin("ward_agent", "W1");
      await r.ok("Two members join and are activated", undefined, async () => { await r.member(agent); await r.member(agent); return "Two active members."; });
      const cid = await contestIn(r, 40);
      await r.advance(20, "20 days pass (20 days before the vote)");
      await r.blocked("Freeze the register", "s.77(4): 21 days before", "register_late", () => contests.freezeRegister(r.ctx, cid));
      const c2 = await contestIn(r, 30, "Second");
      let regId = "";
      await r.ok("Freeze for a contest 30 days out", "s.77(4)", async () => { regId = (await contests.freezeRegister(r.ctx, c2)).registerId; return "Frozen."; });
      await r.ok("A third member joins after the freeze", undefined, async () => { await r.member(agent); return "Active, but not on the frozen register."; });
      await r.ok("Export the register for INEC", "Reg 4", async () => {
        const e = await contests.exportRegister(r.ctx, regId);
        const doc = e.document as any;
        const problems = contests.validateRegisterExport(doc, r.ctx.config.get("register.fields"));
        if (problems.length || doc.members.length !== 2) throw new Error(`unexpected export: ${problems.join(", ")} ${doc.members.length}`);
        return "Exactly the two frozen members, every required field present, no phone numbers.";
      });
      await r.ok("An insider edits the stored fingerprint directly in the database", undefined, async () => {
        await r.ctx.db.query("UPDATE registers SET fingerprint='deadbeef' WHERE id=$1", [regId]); return "Database row changed.";
      });
      await r.blocked("Export the register again", "Integrity", "integrity", () => contests.exportRegister(r.ctx, regId));
    },
  },
  {
    id: "rules-lock", title: "Rules lock once a notice is out", law: "s.85, Reg 23(4), Reg 25(1)",
    blurb: "The party can change its rules before a notice, never after, and can never add extra criteria for aspirants.",
    async run(r) {
      await r.ok("Set the minimum dues to N200", undefined, async () => { await contests.setRule(r.ctx, "dues.min_payment_minor", 20_000, "00000000-0000-4000-8000-000000000001"); return "Rule saved."; });
      await r.blocked("Try to add an aspirant exam score rule", "s.85: no extra criteria", "unknown_rule", () => contests.setRule(r.ctx, "aspirant_exam_score", 1, "00000000-0000-4000-8000-000000000001"));
      await r.blocked("Try to set the donor cap above the legal N500m", "s.94", "invalid_rule", () => contests.setRule(r.ctx, "finance.cap_per_donor_minor", 500_000_001 * 100, "00000000-0000-4000-8000-000000000001"));
      let cid = "";
      await r.ok("Create a contest and issue its notice", "s.82(1)", async () => { cid = await contestIn(r, 30); await contests.generateNotice(r.ctx, cid); return "Notice out. Rules locked."; });
      await r.blocked("Try to change the minimum dues", "Rules lock", "rules_locked", () => contests.setRule(r.ctx, "dues.min_payment_minor", 1, "00000000-0000-4000-8000-000000000001"));
      await r.blocked("Edit the rule history in the database", "Append-only", /immutable/, () => r.ctx.db.query("UPDATE rules SET value='1'"));
      await r.blocked("Delete the rule history in the database", "Append-only", /immutable/, () => r.ctx.db.query("DELETE FROM rules"));
      await r.ok("The contest runs its course and closes", "Rules unlock", async () => { await runCourse(r, cid, false); return "INEC receipts, register freeze, voting and close all happen. Rules unlock."; });
      await r.ok("Change the minimum dues again", undefined, async () => { await contests.setRule(r.ctx, "dues.min_payment_minor", 30_000, "00000000-0000-4000-8000-000000000001"); return "Rule saved."; });
    },
  },
  {
    id: "finance", title: "Money rules: anonymous, foreign, capped", law: "s.94, s.89, Reg 39, 42, 44",
    blurb: "Gifts need a named donor, foreign money is quarantined, donors are capped cumulatively, and the ledger can't be edited.",
    async run(r) {
      await r.blocked("Anonymous gift", "s.94(1)", "anonymous_gift", () => finance.recordGift(r.ctx, NGN(1000), { name: "", address: "x", occupation: "y" }));
      await r.blocked("Gift paid from a US account", "s.89, Reg 42", "foreign_funds", () => finance.recordGift(r.ctx, { ...NGN(1000), country: "US" }, donor));
      await r.blocked("Gift in dollars", "s.89, Reg 42", "foreign_funds", () => finance.recordGift(r.ctx, { ...NGN(1000), currency: "USD" }, donor));
      await r.ok("Check the quarantine", "Reg 42", async () => {
        const n = (await r.ctx.db.query("SELECT 1 FROM quarantine")).length;
        if (n !== 2) throw new Error(`quarantine has ${n}`);
        return "Both refused payments are held in quarantine, nothing reached the ledger.";
      });
      await r.ok("Set the party's own donor cap to N1m", undefined, async () => { await contests.setRule(r.ctx, "finance.cap_per_donor_minor", 100_000_000, "00000000-0000-4000-8000-000000000001"); return "Cap N1,000,000."; });
      await r.ok("Chief A gives N600,000", "Reg 44", async () => { await finance.recordGift(r.ctx, NGN(600_000), donor); return "Recorded."; });
      await r.blocked("Chief A gives N500,000 more (total N1.1m)", "Reg 44: cumulative cap", "over_cap", () => finance.recordGift(r.ctx, NGN(500_000), donor));
      await r.ok("Chief A gives N400,000 (total exactly N1m)", "Reg 44", async () => { await finance.recordGift(r.ctx, NGN(400_000), donor); return "Recorded."; });
      const dup = NGN(1000);
      await r.ok("Another donor gives N1,000", undefined, async () => { await finance.recordGift(r.ctx, dup, { ...donor, name: "B" }); return "Recorded."; });
      await r.blocked("The same payment reference is replayed", "No double count", "duplicate_payment", () => finance.recordGift(r.ctx, dup, { ...donor, name: "C" }));
      await r.blocked("Edit the ledger in the database", "Append-only", /immutable/, () => r.ctx.db.query("UPDATE finance_ledger SET amount_minor=1"));
      await r.ok("Reconcile the ledger", "Reg 43", async () => {
        const rec = await finance.reconcile(r.ctx);
        if (!rec.reconciled) throw new Error("did not reconcile");
        return `Reconciled. Gifts total N${rec.byKind.gift.totalMinor / 100}.`;
      });
    },
  },
  {
    id: "separation", title: "No single person can do the big things", law: "s.96(5)-(6)",
    blurb: "Rule changes and register freezes need other people to approve. Nobody can approve their own proposal. There is no security role.",
    async run(r) {
      const sec = await r.admin("secretary");
      const ec = await r.admin("electoral_committee");
      const aud = await r.admin("auditor");
      const tre = await r.admin("treasurer");
      let id = "";
      await r.blocked("The treasurer tries to propose a rule change", "Roles", "forbidden", () => propose(r.ctx, tre, "rule.set", {}));
      await r.ok("The secretary proposes a higher minimum dues", undefined, async () => { id = await propose(r.ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 50_000 }); return "Proposal waiting for approval."; });
      await r.blocked("The secretary approves her own proposal", "Self-approval", "self_approval", () => approve(r.ctx, sec, id));
      await r.blocked("The treasurer tries to approve", "Roles", "forbidden", () => approve(r.ctx, tre, id));
      await r.ok("The electoral committee approves", undefined, async () => {
        const a = await approve(r.ctx, ec, id);
        return a.executed ? `Executed. Minimum dues is now N${(await contests.getRule<number>(r.ctx, "dues.min_payment_minor")) / 100}.` : "Approved, not yet executed.";
      });
      const cid = await contestIn(r, 40);
      let fid = "";
      await r.ok("The secretary proposes a register freeze", undefined, async () => { fid = await propose(r.ctx, sec, "register.freeze", { contestId: cid }); return "Needs two approvers."; });
      await r.ok("Electoral committee approves", undefined, async () => `Executed: ${(await approve(r.ctx, ec, fid)).executed}. One approval is not enough.`);
      await r.ok("Same person approves again", undefined, async () => `Executed: ${(await approve(r.ctx, ec, fid)).executed}. Still counts once.`);
      await r.ok("The auditor approves", undefined, async () => `Executed: ${(await approve(r.ctx, aud, fid)).executed}. A second, different person.`);
    },
  },
  {
    id: "petitions", title: "Members' petitions reach the agenda", law: "Participation",
    blurb: "When enough members sign, the proposal is queued for formal consideration with a response deadline. One signature each.",
    async run(r) {
      const agent = await r.admin("ward_agent", "W1");
      const ms: string[] = [];
      await r.ok("Three members join and are activated", undefined, async () => { for (let i = 0; i < 3; i++) ms.push((await r.member(agent)).memberId); return "Three active members."; });
      let pid = "";
      await r.ok("Member 1 starts a petition (threshold 3)", undefined, async () => { pid = await participation.createProposal(r.ctx, ms[0], "Open books", "Publish budget", 3); return "Petition open."; });
      await r.ok("Member 1 signs", undefined, async () => { await participation.signProposal(r.ctx, ms[0], pid); return "1 signature."; });
      await r.blocked("Member 1 signs again", "One signature each", "already_signed", () => participation.signProposal(r.ctx, ms[0], pid));
      await r.ok("Member 2 signs", undefined, async () => { await participation.signProposal(r.ctx, ms[1], pid); return "2 signatures. Still open."; });
      await r.ok("Member 3 signs", undefined, async () => {
        const s = await participation.signProposal(r.ctx, ms[2], pid);
        const ag = await r.ctx.db.query<{ respond_by: Date }>("SELECT respond_by FROM agenda");
        return `Threshold reached (queued: ${s.queued}). Leadership must respond by ${new Date(ag[0].respond_by).toISOString().slice(0, 10)}.`;
      });
      await r.ok("A member resigns, then tries to sign another petition", undefined, async () => {
        await members.resign(r.ctx, ms[0]);
        const p2 = await participation.createProposal(r.ctx, ms[1], "t", "b", 5);
        try { await participation.signProposal(r.ctx, ms[0], p2); } catch (e: any) { return `Refused as expected: ${e.code}.`; }
        throw new Error("resigned member could sign");
      });
    },
  },
  {
    id: "privacy", title: "Privacy: public log and erasure", law: "NDPA 2023; public log",
    blurb: "The public log holds no names, NINs or phone numbers. Erasing a member destroys their key, but not while they are on a live register.",
    async run(r) {
      const agent = await r.admin("ward_agent", "W1");
      let m: Awaited<ReturnType<Run["member"]>>;
      await r.ok("A member joins, is activated, and pays dues", undefined, async () => {
        m = await r.member(agent);
        await finance.recordDues(r.ctx, m.memberId, await r.ctx.payments.charge(m.phone, 20_000));
        return "Member paid N200.";
      });
      await r.ok("Search the whole public log for the NIN, phone and name", "Pseudonymous log", async () => {
        const dump = JSON.stringify(r.log.events);
        for (const s of [m.nin, m.phone, "Musa Ibrahim", "Market Road"]) if (dump.includes(s)) throw new Error(`log contains ${s}`);
        return `${r.log.events.length} log entries, none contain the NIN, phone number or name.`;
      });
      await r.ok("Their stored record can be decrypted", undefined, async () => {
        const row = (await r.ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.memberId]))[0];
        const rec = await r.ctx.keys.decrypt(m.memberId, row.record_enc);
        return `Readable while the key exists (NIN ends ${String(rec.national_id).slice(-3)}).`;
      });
      const other = await r.member(agent);
      const cid = await contestIn(r, 40);
      await r.ok("A contest freezes its register (both members are on it)", "s.77(4)", async () => { await contests.freezeRegister(r.ctx, cid); return "Frozen."; });
      await r.blocked("Erase a member who is on the live register", "Legal hold", "legal_hold", () => members.erase(r.ctx, other.memberId));
      await r.ok("The contest runs its course and closes", undefined, async () => { await runCourse(r, cid, true); return "Register no longer live."; });
      await r.ok("Erase the member", "NDPA right to erasure", async () => {
        const row = (await r.ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.memberId]))[0];
        await members.erase(r.ctx, m.memberId);
        try { await r.ctx.keys.decrypt(m.memberId, row.record_enc); } catch { return "Key destroyed. The record is unreadable forever; the row and log entries remain."; }
        throw new Error("record still readable");
      });
    },
  },
  {
    id: "ussd", title: "USSD journey (Musa on a feature phone)", law: "Access for feature-phone users",
    blurb: "Join, set a PIN, pay dues and see the card, all through the same /ussd code path the gateway uses.",
    async run(r) {
      const phone = "+2348055550000", nin = r.freshNin();
      const dial = (text: string, label: string, re: RegExp) =>
        r.ok(label, undefined, async () => {
          const out = await handleUssd(r.ctx, phone, text);
          if (!re.test(out)) throw new Error(`unexpected screen: ${out}`);
          return out;
        });
      await dial("", "Dial the code", /Join/);
      await dial("1", "Press 1: Join", /NIN/);
      await dial(`1*${nin}`, "Enter NIN", /Is this you/);
      await dial(`1*${nin}*1`, "Confirm identity", /INEC/);
      await dial(`1*${nin}*1*2`, "Choose anonymous", /PIN/);
      await dial(`1*${nin}*1*2*4321`, "Choose PIN 4321", /Repeat/);
      await dial(`1*${nin}*1*2*4321*4321`, "Repeat PIN", /You have joined/);
      await dial("2*0000", "Pay dues with a wrong PIN", /Wrong PIN/);
      await dial("2*4321*500", "Pay dues N500 with the right PIN", /Dues of N500/);
      await dial("3*4321", "See the membership card", /provisional/);
      await r.ok("An SMS confirmation was sent", undefined, async () => {
        if (!r.sms.outbox.length) throw new Error("no sms");
        return r.sms.outbox.map((s) => s.text).join(" | ");
      });
    },
  },
  {
    id: "signed-requests", title: "Admin requests must be signed", law: "s.96; no shared logins",
    blurb: "Every admin call carries a signature from that person's own key. Missing, forged, stale-replayed or wrong-role calls are all refused.",
    async run(r) {
      const app = buildServer(r.ctx);
      const sec = await r.admin("secretary");
      const tre = await r.admin("treasurer");
      const body = JSON.stringify({ name: "H", primaryType: "direct", mode: "virtual", voteDate: r.at(40).toISOString() });
      const post = (headers: Record<string, string>) =>
        app.inject({ method: "POST", url: "/admin/contests", headers: { "content-type": "application/json", ...headers }, payload: body });
      const refused = (title: string, law: string, want: number, headers: () => Record<string, string>) =>
        r.blocked(title, law, new RegExp(`HTTP ${want}\\b`), async () => {
          const x = await post(headers());
          if (x.statusCode >= 400) throw new Error(`HTTP ${x.statusCode} ${JSON.parse(x.body).message ?? ""}`);
        });
      await refused("No signature at all", "Signed requests", 401, () => ({}));
      const good = sec.headers("POST", "/admin/contests", body);
      await refused("A forged signature", "Signed requests", 401, () => ({ ...good, "x-signature": "00".repeat(64) }));
      await r.ok("The secretary's correctly signed request", "Signed requests", async () => {
        const x = await post(good);
        if (x.statusCode !== 200) throw new Error(`HTTP ${x.statusCode}`);
        return "HTTP 200: contest created, and the access is written to the log.";
      });
      await refused("The same signed request is replayed", "Replay protection", 401, () => good);
      await refused("The treasurer signs a contest request", "Roles", 403, () => tre.headers("POST", "/admin/contests", body));
    },
  },
  ...LAYER_SCENARIOS,
];

export interface RunResult {
  id: string; title: string; law: string; blurb: string;
  steps: Step[]; passed: boolean; counts: { allowed: number; blocked: number; fail: number }; ms: number;
}

export async function runScenario(id: string): Promise<RunResult | null> {
  const sc = SCENARIOS.find((s) => s.id === id);
  if (!sc) return null;
  const t = Date.now();
  const clock = { now: new Date(T0) };
  const log = new MemoryTrustLog();
  const sms = new SimSms();
  const ctx = await createCtx({ log, sms, clock: () => new Date(clock.now) });
  const run = new Run(ctx, log, sms, clock);
  try {
    await sc.run(run);
  } catch (e: any) {
    run.failed = false;
    await run.ok("Scenario setup", undefined, async () => { throw e; });
  } finally {
    await ctx.db.close();
  }
  const c = { allowed: 0, blocked: 0, fail: 0 };
  for (const s of run.steps) if (s.kind === "allowed") c.allowed++; else if (s.kind === "blocked") c.blocked++; else if (s.kind === "fail") c.fail++;
  return { id: sc.id, title: sc.title, law: sc.law, blurb: sc.blurb, steps: run.steps, passed: c.fail === 0, counts: c, ms: Date.now() - t };
}

/** GET routes only (no CORS preflight from the portal). Nothing here writes to the real database or log. */
export function registerLab(app: FastifyInstance) {
  app.get("/lab/scenarios", async () => SCENARIOS.map(({ id, title, law, blurb }) => ({ id, title, law, blurb })));
  // Results of the last `npm run report` on the host (mounted read-only). Not a live run.
  app.get("/lab/report", async (_req, reply) => {
    try {
      reply.type("application/json");
      return await readFile(process.env.REPORT_PATH ?? "/reports/latest.json", "utf8");
    } catch {
      return reply.status(404).type("application/json").send({ error: "no_report", message: "No test report yet. Run `npm run report` in the openparty folder." });
    }
  });
  app.get("/lab/run/:id", async (req, reply) => {
    const res = await runScenario((req.params as any).id);
    return res ?? reply.status(404).send({ error: "not_found", message: "No such scenario" });
  });
}
