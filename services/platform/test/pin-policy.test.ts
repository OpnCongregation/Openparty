import { describe, expect, it } from "vitest";
import { PIN_POLICY, confirmJoin, prepareJoin, unlockPin, verifyPin } from "../src/members.js";
import { SCHEMA } from "../src/schema.js";
import { freshNin, joinAndActivate, makeAdmin, setup } from "./helpers.js";

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as any).code as string);
async function member() {
  const s = await setup();
  const agent = await makeAdmin(s.ctx, "ward_agent", "W1");
  const m = await joinAndActivate(s.ctx, agent);
  return { ...s, agent, m };
}
const rows = async (ctx: any, id: string) => (await ctx.db.query("SELECT 1 FROM pin_attempts WHERE member_id=$1", [id])).length as number;

describe("F-12: PIN failures are not erased by a successful login", () => {
  it("alternating right and wrong PINs: the failures keep adding up and the fifth locks", async () => {
    const { ctx, m } = await member();
    const seen: string[] = [];
    for (const pin of ["9999", "9999", "1234", "9999", "1234", "9999", "9999", "1234", "1234"]) seen.push(await code(verifyPin(ctx, m.phone, pin)));
    // wrong, wrong, RIGHT, wrong, RIGHT, wrong, wrong (5th failure), then even the right PIN is refused
    expect(seen).toEqual(["pin_wrong", "pin_wrong", "ok", "pin_wrong", "ok", "pin_wrong", "pin_wrong", "pin_locked", "pin_locked"]);
    expect(await rows(ctx, m.memberId)).toBe(5); // successes left no row behind; the five failures stand
  });

  it("an attacker guessing around legitimate logins gets five guesses a day, not five per login", async () => {
    const { ctx, m } = await member();
    let guesses = 0;
    for (let round = 0; round < 12; round++) {
      await code(verifyPin(ctx, m.phone, "1234")); // the real member logs in (may be refused once locked)
      if ((await code(verifyPin(ctx, m.phone, String(1000 + round)))) === "pin_wrong") guesses++;
    }
    expect(guesses).toBeLessThanOrEqual(PIN_POLICY.maxInWindow);
  });

  it("concurrent guesses mixed with logins never exceed the limit", async () => {
    const { ctx, m } = await member();
    const pins = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? "1234" : String(2000 + i)));
    const results = await Promise.all(pins.map((p) => code(verifyPin(ctx, m.phone, p))));
    expect(results.filter((r) => r === "pin_wrong").length).toBeLessThanOrEqual(PIN_POLICY.maxInWindow);
    expect(await rows(ctx, m.memberId)).toBeLessThanOrEqual(PIN_POLICY.maxInWindow);
  });

  it("the 24 hour lock lifts by itself, and failures age out one by one", async () => {
    const { ctx, m, advance } = await member();
    for (let i = 0; i < 5; i++) await code(verifyPin(ctx, m.phone, "9999"));
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("pin_locked");
    advance(0.99);
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("pin_locked"); // not yet a day
    advance(0.02);
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("ok"); // the failures are over 24 hours old
  });

  it("ten failures in 30 days lock the PIN until a ward agent unlocks it, however long you wait", async () => {
    const { ctx, m, advance, agent } = await member();
    for (let i = 0; i < 5; i++) await code(verifyPin(ctx, m.phone, "9999"));
    advance(1.1);
    for (let i = 0; i < 5; i++) expect(await code(verifyPin(ctx, m.phone, "9999"))).toBe("pin_wrong");
    advance(2); // the 24 hour window is empty now, but ten failures sit inside 30 days
    await expect(verifyPin(ctx, m.phone, "1234")).rejects.toMatchObject({ code: "pin_locked", message: expect.stringMatching(/ward agent/) });
    advance(10);
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("pin_locked");
    await unlockPin(ctx, agent, m.memberId);
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("ok");
  });

  it("failures older than 30 days are forgotten", async () => {
    const { ctx, m, advance } = await member();
    for (let i = 0; i < 5; i++) await code(verifyPin(ctx, m.phone, "9999"));
    advance(31);
    expect(await code(verifyPin(ctx, m.phone, "9999"))).toBe("pin_wrong");
    expect(await rows(ctx, m.memberId)).toBe(1); // the five old ones were removed
  });
});

describe("PIN unlock by a ward agent", () => {
  it("clears the failures, logs a pseudonymous event, and only the right kind of agent can do it", async () => {
    const { ctx, log, m, agent } = await member();
    for (let i = 0; i < 5; i++) await code(verifyPin(ctx, m.phone, "9999"));
    const otherWard = await makeAdmin(ctx, "ward_agent", "W2");
    const sec = await makeAdmin(ctx, "secretary");
    expect(await code(unlockPin(ctx, sec, m.memberId))).toBe("forbidden");
    expect(await code(unlockPin(ctx, otherWard, m.memberId))).toBe("wrong_ward"); // she is activated in W1
    expect(await code(unlockPin(ctx, agent, "no-such-member"))).toBe("not_found");
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("pin_locked");
    await unlockPin(ctx, agent, m.memberId);
    expect(await code(verifyPin(ctx, m.phone, "1234"))).toBe("ok");
    const ev = log.events.filter((e) => e.type === "member.pin_unlocked");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0].data)).not.toContain(m.nin);
    expect(JSON.stringify(ev[0].data)).not.toContain(m.phone);
  });

  it("any ward agent may unlock a provisional member who has no ward yet", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W9");
    const phone = "+2348055577001";
    await prepareJoin(ctx, phone, freshNin());
    const j = await confirmJoin(ctx, phone, "visible", "1234");
    for (let i = 0; i < 5; i++) await code(verifyPin(ctx, phone, "0000"));
    await unlockPin(ctx, agent, j.memberId);
    expect(await code(verifyPin(ctx, phone, "1234"))).toBe("ok");
  });

  it("a member who resigns and rejoins starts with a clean record", async () => {
    const { ctx, m } = await member();
    for (let i = 0; i < 4; i++) await code(verifyPin(ctx, m.phone, "9999"));
    const { resign } = await import("../src/members.js");
    await resign(ctx, m.memberId);
    await prepareJoin(ctx, m.phone, m.nin);
    await confirmJoin(ctx, m.phone, "visible", "4321");
    expect(await rows(ctx, m.memberId)).toBe(0);
  });
});

describe("PIN and limiter state are crash-durable by construction", () => {
  it("pin_attempts and the authentication-failure counters are LOGGED tables; volume counters are not", async () => {
    const { ctx } = await setup();
    const kind = async (t: string) => (await ctx.db.query<{ p: string }>("SELECT relpersistence AS p FROM pg_class WHERE relname=$1 AND relnamespace = current_schema()::regnamespace", [t]))[0]?.p;
    expect(await kind("pin_attempts")).toBe("p");
    expect(await kind("rate_limits_durable")).toBe("p");
    expect(await kind("rate_limits")).toBe("u"); // allowed to reset: ordinary traffic budgets only
  });

  it("the old per-member counter is moved into attempt rows once, then zeroed", async () => {
    const { ctx, m } = await member();
    await ctx.db.query("UPDATE members SET pin_failures=3 WHERE id=$1", [m.memberId]);
    await ctx.db.exec(SCHEMA);
    expect(await rows(ctx, m.memberId)).toBe(3);
    expect((await ctx.db.query("SELECT pin_failures FROM members WHERE id=$1", [m.memberId]))[0].pin_failures).toBe(0);
    await ctx.db.exec(SCHEMA); // restarting again must not add more
    expect(await rows(ctx, m.memberId)).toBe(3);
  });
});
