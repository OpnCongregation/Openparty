import type { Ctx } from "./context.js";
import { DomainError } from "./errors.js";
import { t, tSpecific } from "./i18n.js";
import { confirmJoin, prepareJoin, verifyPin } from "./members.js";
import { recordDues } from "./finance.js";

const con = (s: string) => `CON ${s}`;
const end = (s: string) => `END ${s}`;

/**
 * Africa's Talking-style USSD: `text` is every answer so far joined by "*". Stateless apart from the
 * short-lived ID check held in ctx.pending, so any server instance can answer any step.
 * All wording comes from locales/*.json; the ID prompt follows the deployment's ID adapter.
 */
export async function handleUssd(ctx: Ctx, phone: string, text: string): Promise<string> {
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
      const pay = await ctx.payments.charge(phone, units * cur.minor_per_unit);
      await recordDues(ctx, m.id, pay);
      await ctx.sms.send(phone, t(ctx, "sms.dues", cur.symbol, units, pay.ref));
      return end(t(ctx, "ussd.paid", cur.symbol, units));
    }

    if (s[0] === "3") {
      if (s.length === 1) return con(t(ctx, "ussd.enterPin"));
      const m = await verifyPin(ctx, phone, s[1]);
      return end(t(ctx, "ussd.card", m.cardNo, m.state));
    }
    return end(t(ctx, "ussd.bad"));
  } catch (e) {
    if (e instanceof DomainError) return end(e.message);
    throw e;
  }
}
