import type { Ctx } from "./context.js";
import { DomainError } from "./errors.js";
import { t, tSpecific } from "./i18n.js";
import { confirmJoin, missingRegisterFields, prepareJoin, verifyPin } from "./members.js";
import { SELF_SERVICE_FIELDS, completeRecord } from "./record-notices.js";
import { randomUUID } from "node:crypto";
import { collectDues } from "./finance.js";
import { ballotView, castBallot, currentOpenContest } from "./election.js";

const con = (s: string) => `CON ${s}`;
const end = (s: string) => `END ${s}`;

/**
 * Africa's Talking-style USSD: `text` is every answer so far joined by "*". Stateless apart from the
 * short-lived ID check held (encrypted) in the pending_joins table, so any server instance can answer any step.
 * All wording comes from locales/*.json; the ID prompt follows the deployment's ID adapter.
 */
export async function handleUssd(ctx: Ctx, phone: string, text: string, sessionId?: string): Promise<string> {
  const s = text === "" ? [] : text.split("*");
  const cur = ctx.config.pack.currency;
  try {
    if (s.length === 0) return con(t(ctx, "ussd.menu"));

    if (s[0] === "1") {
      if (s.length === 1) return con(tSpecific(ctx, "ussd.askId", ctx.idAdapter.id));
      if (s.length === 2) {
        const { preview } = await prepareJoin(ctx, phone, s[1]);
        return con(t(ctx, "ussd.confirm", preview));
      }
      if (s[2] === "2") return end(t(ctx, "ussd.cancelled"));
      if (s[2] !== "1") return end(t(ctx, "ussd.bad"));
      if (s.length === 3) return con(t(ctx, "ussd.legal", ctx.config.pack.regulator));
      if (!["1", "2"].includes(s[3])) return end(t(ctx, "ussd.bad"));
      if (s.length === 4) return con(t(ctx, "ussd.askPin"));
      if (s.length === 5) return con(t(ctx, "ussd.repeatPin"));
      if (s[4] !== s[5]) return end(t(ctx, "ussd.pinMismatch"));
      const r = await confirmJoin(ctx, phone, s[3] === "1" ? "visible" : "anonymous", s[4]);
      return end(t(ctx, "ussd.joined", r.cardNo));
    }

    if (s[0] === "2") {
      if (s.length === 1) return con(t(ctx, "ussd.enterPin"));
      const m = await verifyPin(ctx, phone, s[1]);
      if (s.length === 2) return con(t(ctx, "ussd.amount", cur.code));
      const units = Number(s[2]);
      if (!Number.isInteger(units) || units <= 0) return end(t(ctx, "ussd.bad"));
      // The gateway repeats sessionId on every step of one dial, so a repeated final request maps to the same key and
      // cannot charge twice. The key is a keyed hash: the PIN inside `text` must never be stored or logged in the clear.
      const key = sessionId ? ctx.keys.lookupHash("pay", `${sessionId}|${phone}|${text}`) : randomUUID();
      const r = await collectDues(ctx, m.id, phone, units * cur.minor_per_unit, key);
      if (!r.duplicate) await ctx.sms.send(phone, t(ctx, "sms.dues", cur.symbol, units, r.payment.ref));
      return end(t(ctx, "ussd.paid", cur.symbol, units));
    }

    if (s[0] === "3") {
      if (s.length === 1) return con(t(ctx, "ussd.enterPin"));
      const m = await verifyPin(ctx, phone, s[1]);
      return end(t(ctx, "ussd.card", m.cardNo, m.state));
    }
    if (s[0] === "4") {
      if (s.length === 1) return con(t(ctx, "ussd.enterPin"));
      const m = await verifyPin(ctx, phone, s[1]);
      const rec = await ctx.keys.decrypt<Record<string, string>>(m.id, (await ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.id]))[0].record_enc);
      const missing = missingRegisterFields(rec, ctx.config.get<string[]>("register.fields"));
      const mine = missing.filter((f) => (SELF_SERVICE_FIELDS as readonly string[]).includes(f));
      const others = missing.filter((f) => !mine.includes(f));
      const label = (f: string) => f.replace(/_/g, " ");
      if (!mine.length) return end(others.length ? t(ctx, "ussd.record.agent", others.map(label).join(", ")) : t(ctx, "ussd.record.none"));
      const answers = s.slice(2);
      if (answers.length < mine.length) return con(t(ctx, "ussd.record.ask", label(mine[answers.length])));
      await completeRecord(ctx, m.id, Object.fromEntries(mine.map((f, i) => [f, answers[i]])), { self: true });
      return end(others.length ? t(ctx, "ussd.record.agent", others.map(label).join(", ")) : t(ctx, "ussd.record.done"));
    }
    if (s[0] === "5") {
      if (s.length === 1) return con(t(ctx, "ussd.enterPin"));
      const m = await verifyPin(ctx, phone, s[1]);
      const contestId = await currentOpenContest(ctx, m.id);
      if (!contestId) return end(t(ctx, "ussd.vote.closed"));
      const view = await ballotView(ctx, m.id, contestId);
      if (!view.eligible) return end(t(ctx, "ussd.vote.notEligible"));
      if (!view.races.length) return end(t(ctx, "ussd.vote.noBallot"));
      const step = voteStep(view.races, s.slice(2));
      if ("prompt" in step) return con(step.prompt);
      if (!step.confirmed) return end(t(ctx, "ussd.vote.cancelled"));
      const r = await castBallot(ctx, { memberId: m.id, contestId, choices: step.choices, channel: "ussd", notifyPhone: phone });
      return end(t(ctx, "ussd.vote.done", r.receipts[0].receipt.slice(0, 8).toUpperCase()));
    }
    return end(t(ctx, "ussd.bad"));
  } catch (e) {
    if (e instanceof DomainError) return end(e.message);
    throw e;
  }
}

// ---- Voting on a feature phone. One race per screen, candidates 1 to 8, 9 = next page, 0 = abstain, then one confirmation. ----
const PAGE = 8;
const clip = (x: string, n: number) => (x.length > n ? x.slice(0, n - 1) + "." : x);

type VoteRace = { id: string; office: string; candidates: { id: string; name: string }[]; current: { candidacyId: string | null } | null };

/** Stateless: reads every answer so far and returns the next screen, or the finished choices. A bad answer ends the session. */
export function voteStep(races: VoteRace[], answers: string[]): { prompt: string } | { confirmed: boolean; choices: Record<string, string | null> } {
  const choices: Record<string, string | null> = {};
  const picked: string[] = [];
  let i = 0;
  for (let ri = 0; ri < races.length; ri++) {
    const race = races[ri];
    let page = 0;
    for (;;) {
      const slice = race.candidates.slice(page * PAGE, (page + 1) * PAGE);
      const more = race.candidates.length > (page + 1) * PAGE;
      const a = answers[i];
      if (a === undefined) {
        const lines = slice.map((c, n) => `${n + 1} ${clip(c.name, 18)}`);
        if (more) lines.push("9 More");
        lines.push("0 Abstain");
        return { prompt: `${clip(race.office, 28)} (${ri + 1}/${races.length})\n${lines.join("\n")}` };
      }
      i++;
      if (a === "9" && more) { page++; continue; }
      if (a === "0") { choices[race.id] = null; picked.push(`${clip(race.office, 14)}: none`); break; }
      const n = Number(a);
      if (!Number.isInteger(n) || n < 1 || n > slice.length) throw new DomainError("bad_choice", "Invalid choice. Dial again.", 400);
      choices[race.id] = slice[n - 1].id;
      picked.push(`${clip(race.office, 14)}: ${clip(slice[n - 1].name, 14)}`);
      break;
    }
  }
  const c = answers[i];
  if (c === undefined) return { prompt: clip(`Confirm?\n${picked.join("\n")}\n1 Yes 2 No`, 176) };
  if (c !== "1" && c !== "2") throw new DomainError("bad_choice", "Invalid choice. Dial again.", 400);
  return { confirmed: c === "1", choices };
}
