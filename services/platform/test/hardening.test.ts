import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { approve, propose } from "../src/admin.js";
import { SimPayments, type IncomingPayment, type Payments } from "../src/adapters.js";
import * as contests from "../src/contests.js";
import { KeyStore, SoftwareKeyProvider, keyProviderFromEnv, ErasedError } from "../src/crypto.js";
import { openDb } from "../src/db.js";
import * as finance from "../src/finance.js";
import { prepareJoin, confirmJoin, verifyPin } from "../src/members.js";
import { createCtx } from "../src/platform.js";
import { buildServer } from "../src/server.js";
import { handleUssd } from "../src/ussd.js";
import { freshNin, joinAndActivate, makeAdmin, setup } from "./helpers.js";

const SECRET = "test-secret-0123456789";
const form = { "content-type": "application/x-www-form-urlencoded" };

describe("F-01: the USSD webhook does not believe an unauthenticated caller", () => {
  const post = (app: ReturnType<typeof buildServer>, headers: Record<string, string>, payload: string, url = "/ussd") =>
    app.inject({ method: "POST", url, headers: { ...form, ...headers }, payload });
  const body = (phone = "+2348000000099", text = "") => `sessionId=s1&phoneNumber=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`;

  it("refuses a missing or wrong secret and accepts the header or Basic auth", async () => {
    const { ctx } = await setup();
    const app = buildServer(ctx, { ussd: { secret: SECRET } });
    expect((await post(app, {}, body())).statusCode).toBe(401);
    expect((await post(app, { "x-ussd-secret": "wrong-secret-0123456789" }, body())).statusCode).toBe(401);
    expect((await post(app, { "x-ussd-secret": SECRET }, body())).statusCode).toBe(200);
    const basic = "Basic " + Buffer.from(`gateway:${SECRET}`).toString("base64");
    expect((await post(app, { authorization: basic }, body())).statusCode).toBe(200);
  });

  it("registers no authenticated route at all when no secret is configured (fails closed)", async () => {
    const { ctx } = await setup();
    const app = buildServer(ctx, { ussd: {} });
    expect((await post(app, { "x-ussd-secret": SECRET }, body())).statusCode).toBe(404);
  });

  it("only the simulator route skips the secret, and only when asked for", async () => {
    const { ctx } = await setup();
    expect((await post(buildServer(ctx, { ussd: { secret: SECRET } }), {}, body(), "/ussd/sim")).statusCode).toBe(404);
    expect((await post(buildServer(ctx, { ussd: { secret: SECRET, sim: true } }), {}, body(), "/ussd/sim")).statusCode).toBe(200);
  });

  it("checks the source address when an allowlist is set", async () => {
    const { ctx } = await setup();
    const open = buildServer(ctx, { ussd: { secret: SECRET, allowedIps: ["203.0.113.9"] } });
    expect((await post(open, { "x-ussd-secret": SECRET }, body())).statusCode).toBe(403); // inject comes from 127.0.0.1
    const local = buildServer(ctx, { ussd: { secret: SECRET, allowedIps: ["127.0.0.1"] } });
    expect((await post(local, { "x-ussd-secret": SECRET }, body())).statusCode).toBe(200);
    // An empty list (an unset variable passed through compose) means no allowlist, not "nobody may call".
    const none = buildServer(ctx, { ussd: { secret: SECRET, allowedIps: [] } });
    expect((await post(none, { "x-ussd-secret": SECRET }, body())).statusCode).toBe(200);
  });

  it("validates the payload", async () => {
    const { ctx } = await setup();
    const app = buildServer(ctx, { ussd: { secret: SECRET } });
    const h = { "x-ussd-secret": SECRET };
    for (const bad of [body("08000000099"), body("+234 800"), body("+2348000000099", "1*abc"), body("+2348000000099", "1".repeat(201)), "text=1", "phoneNumber=%2B2348000000099&text=1&sessionId=a%20b"])
      expect((await post(app, h, bad)).statusCode, bad).toBe(400);
  });

  it("rate limits per phone and per source address", async () => {
    const { ctx } = await setup();
    const perPhone = buildServer(ctx, { ussd: { secret: SECRET, perPhone: 3, perIp: 1000, windowMs: 3_600_000 } });
    const h = { "x-ussd-secret": SECRET };
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(perPhone, h, body())).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await post(perPhone, h, body("+2348000000100"))).statusCode).toBe(200); // other numbers unaffected

    // Counters are shared through the database now, so the address budget needs a database of its own.
    const perIp = buildServer((await setup()).ctx, { ussd: { secret: SECRET, perIp: 2, windowMs: 3_600_000 } });
    const wrong: number[] = [];
    for (let i = 0; i < 4; i++) wrong.push((await post(perIp, { "x-ussd-secret": "guess" + i }, body())).statusCode);
    expect(wrong).toEqual([401, 401, 429, 429]); // guessing the secret is throttled
  });

  it("parallel PIN guesses cannot exceed the attempt limit", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => verifyPin(ctx, m.phone, "9999")));
    const codes = results.map((r) => (r.status === "rejected" ? (r.reason as any).code : "ok"));
    expect(codes.filter((c) => c === "pin_wrong")).toHaveLength(5);
    expect(codes.filter((c) => c === "pin_locked")).toHaveLength(20);
    await expect(verifyPin(ctx, m.phone, "1234")).rejects.toMatchObject({ code: "pin_locked" }); // even the right PIN
  });
});

describe("F-06: an approval executes once, however many requests race", () => {
  it("simultaneous final approvals run the action a single time", async () => {
    const { ctx, log } = await setup();
    const sec = await makeAdmin(ctx, "secretary");
    const ecs = await Promise.all(Array.from({ length: 6 }, () => makeAdmin(ctx, "electoral_committee")));
    const id = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 50_000 });
    const results = await Promise.allSettled(ecs.map((e) => approve(ctx, e, id)));
    // A request that loses the race either records its vote and sees "not executed", or arrives after the run and is refused.
    for (const r of results) if (r.status === "rejected") expect((r.reason as any).code).toBe("bad_state");
    const executed = results.filter((r: any) => r.status === "fulfilled" && r.value.executed);
    expect(executed).toHaveLength(1);
    expect(log.events.filter((e) => e.type === "approval.executed")).toHaveLength(1);
    expect(log.events.filter((e) => e.type === "rule.set")).toHaveLength(1);
    expect(await contests.getRule(ctx, "dues.min_payment_minor")).toBe(50_000);
    const row = await ctx.db.query<{ status: string }>("SELECT status FROM approvals WHERE id=$1", [id]);
    expect(row[0].status).toBe("executed");
  });

  it("an approval that already ran cannot be approved again", async () => {
    const { ctx } = await setup();
    const sec = await makeAdmin(ctx, "secretary");
    const ec = await makeAdmin(ctx, "electoral_committee");
    const ec2 = await makeAdmin(ctx, "electoral_committee");
    const id = await propose(ctx, sec, "rule.set", { key: "dues.min_payment_minor", value: 20_000 });
    expect((await approve(ctx, ec, id)).executed).toBe(true);
    await expect(approve(ctx, ec2, id)).rejects.toMatchObject({ code: "bad_state" });
  });
});

/** Payments stub whose failures we control, and which honours idempotency keys like a real provider must. */
class FlakyPayments implements Payments {
  charges = 0;
  failNext = false;
  private byKey = new Map<string, IncomingPayment>();
  async charge(_phone: string, amountMinor: number, key?: string): Promise<IncomingPayment> {
    if (this.failNext) { this.failNext = false; throw new Error("provider timeout"); }
    const seen = key && this.byKey.get(key);
    if (seen) return seen;
    this.charges++;
    const p = { ref: `FLK-${this.charges}`, amountMinor, currency: "NGN", country: "NG" };
    if (key) this.byKey.set(key, p);
    return p;
  }
}

describe("F-09: dues are collected once and reconcile after failures", () => {
  async function member() {
    const payments = new FlakyPayments();
    const { ctx, log } = await (async () => {
      const s = await setup();
      s.ctx.payments = payments;
      return s;
    })();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    return { ctx, log, payments, m };
  }
  const ledgerRows = async (ctx: any) => (await ctx.db.query("SELECT 1 FROM finance_ledger WHERE kind='dues'")).length;

  it("the same key charges and records once, however often it is repeated", async () => {
    const { ctx, payments, m } = await member();
    const a = await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-1");
    const b = await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-1");
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.ledgerId).toBe(a.ledgerId);
    expect(payments.charges).toBe(1);
    expect(await ledgerRows(ctx)).toBe(1);
  });

  it("a key cannot be reused for a different amount", async () => {
    const { ctx, m } = await member();
    await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-2");
    await expect(finance.collectDues(ctx, m.memberId, m.phone, 30_000, "k-2")).rejects.toMatchObject({ code: "key_reuse" });
  });

  it("charge succeeds but recording fails: it is reported, then recorded exactly once on retry", async () => {
    const { ctx, payments, m } = await member();
    // The ledger insert now runs on a transaction handle, so the fault is injected there.
    const realTx = ctx.db.tx.bind(ctx.db);
    let down = true;
    ctx.db.tx = ((fn: any) => realTx((tx: any) => {
      const q = tx.query.bind(tx);
      tx.query = async (sql: string, params?: unknown[]) => {
        if (down && sql.includes("INSERT INTO finance_ledger")) throw new Error("db down");
        return q(sql, params);
      };
      return fn(tx);
    })) as typeof ctx.db.tx;

    await expect(finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-3")).rejects.toThrow("db down");
    expect(payments.charges).toBe(1);
    expect(await ledgerRows(ctx)).toBe(0);
    const before = await finance.reconcile(ctx);
    expect(before.reconciled).toBe(false);
    expect(before.unsettledPayments.charged).toMatchObject({ count: 1, totalMinor: 20_000 });

    expect(await finance.retryUnrecorded(ctx)).toMatchObject({ recorded: 0, stillFailing: 1 }); // still down
    down = false;
    expect(await finance.retryUnrecorded(ctx)).toMatchObject({ recorded: 1, stillFailing: 0 });
    expect(await finance.retryUnrecorded(ctx)).toMatchObject({ recorded: 0 }); // nothing left, no duplicate
    expect(await ledgerRows(ctx)).toBe(1);
    expect(payments.charges).toBe(1);
    expect((await finance.reconcile(ctx)).reconciled).toBe(true);
  });

  it("a provider timeout is reported as unconfirmed, and the retry with the same key does not double charge", async () => {
    const { ctx, payments, m } = await member();
    payments.failNext = true;
    await expect(finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-4")).rejects.toMatchObject({ code: "payment_unconfirmed" });
    expect((await finance.reconcile(ctx)).unsettledPayments.charging).toMatchObject({ count: 1 });
    const r = await finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-4");
    expect(r.duplicate).toBe(false);
    expect(payments.charges).toBe(1);
    expect(await ledgerRows(ctx)).toBe(1);
    expect((await finance.reconcile(ctx)).reconciled).toBe(true);
  });

  it("money the provider took but a rule refused is kept visible as refund due", async () => {
    const { ctx, m } = await member();
    ctx.payments = new SimPayments("USD", "US"); // foreign payer: refused after the charge
    await expect(finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-5")).rejects.toMatchObject({ code: "foreign_funds" });
    const rec = await finance.reconcile(ctx);
    expect(rec.unsettledPayments.refund_due).toMatchObject({ count: 1 });
    await expect(finance.collectDues(ctx, m.memberId, m.phone, 20_000, "k-5")).rejects.toMatchObject({ code: "refund_due" });
  });

  it("rules that can be checked beforehand refuse before any money moves", async () => {
    const { ctx, payments, m } = await member();
    await expect(finance.collectDues(ctx, m.memberId, m.phone, 1, "k-6")).rejects.toMatchObject({ code: "dues_too_low" });
    expect(payments.charges).toBe(0);
    expect((await ctx.db.query("SELECT 1 FROM payment_attempts")).length).toBe(0);
  });

  it("a repeated USSD request with the same gateway session pays once and never stores the PIN", async () => {
    const { ctx, payments, m } = await member();
    const text = "2*1234*500";
    const first = await handleUssd(ctx, m.phone, text, "sess-1");
    const again = await handleUssd(ctx, m.phone, text, "sess-1");
    expect(first).toMatch(/^END Dues of N500/);
    expect(again).toMatch(/^END Dues of N500/);
    expect(payments.charges).toBe(1);
    expect(await ledgerRows(ctx)).toBe(1);
    const keys = (await ctx.db.query<{ key: string }>("SELECT key FROM payment_attempts")).map((r) => r.key).join(" ");
    expect(keys).not.toContain("1234");
    expect(keys).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("F-03: master key ring, rotation and erasure", () => {
  const ring = (ids: string[], active: string) => new SoftwareKeyProvider(Object.fromEntries(ids.map((i) => [i, randomBytes(32)])), active);

  it("data wrapped under the single legacy key still opens, and the legacy format is read as k0", async () => {
    const db = await openDb();
    const master = randomBytes(32);
    const legacy = new KeyStore(db, master, randomBytes(32)); // the old constructor form
    await legacy.createKey("m1");
    const blob = await legacy.encrypt("m1", { a: 1 });
    // Simulate a row written before key ids existed: "v1.iv.tag.ct".
    const [, , iv, tag, ct] = (await db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM member_keys"))[0].wrapped_key.split(".");
    expect(await db.query("SELECT 1 FROM member_keys WHERE wrapped_key LIKE 'v2.k0.%'")).toHaveLength(1);
    await db.query("UPDATE member_keys SET wrapped_key=$1", [["v1", iv, tag, ct].join(".")]);
    expect(await legacy.decrypt("m1", blob)).toEqual({ a: 1 });
    expect(await legacy.keyUsage()).toEqual({ k0: 1 });
  });

  it("rotation rewraps everything under the new key; the old key can then be dropped", async () => {
    const db = await openDb();
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const before = new KeyStore(db, new SoftwareKeyProvider({ k1 }, "k1"), randomBytes(32));
    for (let i = 0; i < 7; i++) await before.createKey(`m${i}`);
    const blob = await before.encrypt("m3", { secret: "x" });
    expect(await before.keyUsage()).toEqual({ k1: 7 });

    const after = new KeyStore(db, new SoftwareKeyProvider({ k1, k2 }, "k2"), randomBytes(32));
    await after.createKey("new"); // new keys use the active key straight away
    expect(await after.keyUsage()).toEqual({ k1: 7, k2: 1 });
    expect(await after.rewrapAll(3)).toEqual({ rewrapped: 7, remaining: 0 }); // batches of 3
    expect(await after.keyUsage()).toEqual({ k2: 8 });
    expect(await after.rewrapAll()).toEqual({ rewrapped: 0, remaining: 0 }); // idempotent

    const onlyK2 = new KeyStore(db, new SoftwareKeyProvider({ k2 }, "k2"), randomBytes(32)); // k1 destroyed
    expect(await onlyK2.decrypt("m3", blob)).toEqual({ secret: "x" });
  });

  it("without the old key, data still wrapped under it is unreadable (what destroying a key means)", async () => {
    const db = await openDb();
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const a = new KeyStore(db, new SoftwareKeyProvider({ k1 }, "k1"), randomBytes(32));
    await a.createKey("m1");
    const blob = await a.encrypt("m1", { s: 1 });
    const b = new KeyStore(db, new SoftwareKeyProvider({ k2 }, "k2"), randomBytes(32));
    await expect(b.decrypt("m1", blob)).rejects.toThrow(/"k1" is not available/);
  });

  it("a wrapped key cannot be moved to another member (bound to its id)", async () => {
    const db = await openDb();
    const ks = new KeyStore(db, ring(["k1"], "k1"), randomBytes(32));
    await ks.createKey("a");
    await ks.createKey("b");
    const wa = (await db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM member_keys WHERE member_id='a'"))[0].wrapped_key;
    await db.query("UPDATE member_keys SET wrapped_key=$1 WHERE member_id='b'", [wa]);
    await expect(ks.encrypt("b", {})).rejects.toThrow();
  });

  it("erasure: the record is unreadable even though the master key is still available", async () => {
    const { ctx } = await setup();
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const rec = (await ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.memberId]))[0].record_enc;
    const { erase } = await import("../src/members.js");
    await erase(ctx, m.memberId);
    await expect(ctx.keys.decrypt(m.memberId, rec)).rejects.toBeInstanceOf(ErasedError);
  });

  it("the limit, stated as a test: a restored copy of the wrapped key reopens an erased record while its master key exists", async () => {
    const db = await openDb();
    const ks = new KeyStore(db, ring(["k1"], "k1"), randomBytes(32));
    await ks.createKey("m1");
    const blob = await ks.encrypt("m1", { name: "Musa" });
    const backup = await db.query<{ member_id: string; wrapped_key: string }>("SELECT * FROM member_keys"); // a database backup
    await ks.shred("m1");
    await expect(ks.decrypt("m1", blob)).rejects.toBeInstanceOf(ErasedError);
    await db.query("INSERT INTO member_keys(member_id, wrapped_key) VALUES ($1,$2)", [backup[0].member_id, backup[0].wrapped_key]); // restore
    expect(await ks.decrypt("m1", blob)).toEqual({ name: "Musa" });
    // ...and this is why backups must be wrapped under a key that is destroyed when they expire (docs/key-management.md).
  });

  it("reads the key ring from the environment and refuses malformed settings", () => {
    const h1 = "a".repeat(64), h2 = "b".repeat(64);
    expect(keyProviderFromEnv({})).toBeUndefined();
    expect(keyProviderFromEnv({ MASTER_KEY_HEX: h1 })!.activeId).toBe("k0");
    const p = keyProviderFromEnv({ MASTER_KEYS: `k1:${h1},k2:${h2}`, MASTER_KEY_ACTIVE: "k2" })!;
    expect(p.activeId).toBe("k2");
    expect(keyProviderFromEnv({ MASTER_KEYS: `k1:${h1}`, MASTER_KEY_HEX: h2, MASTER_KEY_ACTIVE: "k1" })!.keyIdOf("v1.a.b.c")).toBe("k0");
    expect(() => keyProviderFromEnv({ MASTER_KEYS: "k1:short" })).toThrow(/64 hex/);
    expect(() => keyProviderFromEnv({ MASTER_KEYS: `k1:${h1}`, MASTER_KEY_ACTIVE: "nope" })).toThrow(/not in the key ring/);
    expect(() => keyProviderFromEnv({ MASTER_KEYS: `k0:${h1}`, MASTER_KEY_HEX: h2 })).toThrow(/twice|also defines/);
    expect(() => keyProviderFromEnv({ MASTER_KEYS: `bad.id:${h1}` })).toThrow(/bad master key id/);
  });
});
