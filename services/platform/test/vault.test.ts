import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { ErasedError, KeyStore } from "../src/crypto.js";
import { erase } from "../src/members.js";
import { createCtx } from "../src/platform.js";
import { VaultTransitKeyProvider, loadKeyProvider } from "../src/vault-provider.js";
import { openDb } from "../src/db.js";
import { joinAndActivate, makeAdmin } from "./helpers.js";

// These run against a real Vault server (scripts/test-vault.mjs starts a throwaway one). Skipped otherwise.
const ADDR = process.env.VAULT_TEST_ADDR;
const d = ADDR ? describe : describe.skip;
const fresh = () => new VaultTransitKeyProvider({ addr: ADDR!, token: "root", key: `t-${randomBytes(4).toString("hex")}`, createIfMissing: true }).init();

d("F-14: Vault Transit as the master key service", () => {
  it("wraps and unwraps a data key; the key material never appears in the blob; software=false", async () => {
    const p = await fresh();
    expect(p.software).toBe(false);
    const dek = randomBytes(32);
    const blob = await p.wrap(dek, "wrap:m1");
    expect(blob).toMatch(/^v3\.vault-v1\.vault:v1:/);
    expect(p.keyIdOf(blob)).toBe("vault-v1");
    expect(blob).not.toContain(dek.toString("base64"));
    expect((await p.unwrap(blob, "wrap:m1")).equals(dek)).toBe(true);
  });

  it("binds a wrapped key to its member: the same blob will not open under another identity", async () => {
    const p = await fresh();
    const blob = await p.wrap(randomBytes(32), "wrap:alice");
    await expect(p.unwrap(blob, "wrap:bob")).rejects.toThrow(/could not unwrap/);
  });

  it("refuses a transit key that is not derived (the binding above would silently not exist)", async () => {
    const key = `plain-${randomBytes(3).toString("hex")}`;
    await fetch(`${ADDR}/v1/sys/mounts/transit`, { method: "POST", headers: { "X-Vault-Token": "root" }, body: JSON.stringify({ type: "transit" }) });
    await fetch(`${ADDR}/v1/transit/keys/${key}`, { method: "POST", headers: { "X-Vault-Token": "root" }, body: JSON.stringify({ derived: false }) });
    await expect(new VaultTransitKeyProvider({ addr: ADDR!, token: "root", key }).init()).rejects.toThrow(/not derived/);
  });

  it("rotation: new wraps use the new version, old blobs still open, rewrapAll moves every row, and the old version can then be destroyed", async () => {
    const p = await fresh();
    const db = await openDb();
    const ks = new KeyStore(db, p, randomBytes(32));
    for (let i = 0; i < 5; i++) await ks.createKey(`m${i}`);
    const blob = await ks.encrypt("m3", { secret: "x" });
    expect(await ks.keyUsage()).toEqual({ "vault-v1": 5 });

    expect(await p.rotateKey()).toBe(2);
    await ks.createKey("fresh");
    expect(await ks.keyUsage()).toEqual({ "vault-v1": 5, "vault-v2": 1 });
    expect(await ks.decrypt("m3", blob)).toEqual({ secret: "x" }); // old version still reads

    // A backup of the database taken now still holds v1-wrapped keys.
    const backup = await db.query<{ member_id: string; wrapped_key: string }>("SELECT * FROM member_keys WHERE member_id='m3'");

    expect(await ks.rewrapAll(2)).toEqual({ rewrapped: 5, remaining: 0 });
    expect(await ks.keyUsage()).toEqual({ "vault-v2": 6 });
    expect(await ks.decrypt("m3", blob)).toEqual({ secret: "x" });

    await p.destroyVersionsBelow(2); // the master key version is destroyed
    expect(await ks.decrypt("m3", blob)).toEqual({ secret: "x" }); // live data was already rewrapped
    // ...and the backup taken before is now permanently unreadable, which is the point.
    await db.query("DELETE FROM member_keys WHERE member_id='m3'");
    await db.query("INSERT INTO member_keys(member_id, wrapped_key) VALUES ($1,$2)", [backup[0].member_id, backup[0].wrapped_key]);
    await expect(ks.decrypt("m3", blob)).rejects.toThrow(/could not unwrap/);
  });

  it("works end to end: join, activate, read the register record, erase, and the record is gone", async () => {
    const provider = await fresh();
    const ctx = await createCtx({ keyProvider: provider, pepperHex: randomBytes(32).toString("hex") });
    expect(ctx.keys.software).toBe(false);
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const m = await joinAndActivate(ctx, agent);
    const rec = (await ctx.db.query<{ record_enc: string }>("SELECT record_enc FROM members WHERE id=$1", [m.memberId]))[0].record_enc;
    expect((await ctx.keys.decrypt<any>(m.memberId, rec)).national_id).toBe(m.nin);
    expect((await ctx.db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM member_keys WHERE member_id=$1", [m.memberId]))[0].wrapped_key).toMatch(/^v3\.vault-v1\./);
    await erase(ctx, m.memberId);
    await expect(ctx.keys.decrypt(m.memberId, rec)).rejects.toBeInstanceOf(ErasedError);
  });

  it("loadKeyProvider builds it from the environment, and reports a wrong token plainly", async () => {
    const key = `env-${randomBytes(3).toString("hex")}`;
    const p = await loadKeyProvider({ KEY_PROVIDER: "vault", VAULT_ADDR: ADDR, VAULT_TOKEN: "root", VAULT_TRANSIT_KEY: key, VAULT_CREATE_IF_MISSING: "1" });
    expect(p?.software).toBe(false);
    await expect(loadKeyProvider({ KEY_PROVIDER: "vault", VAULT_ADDR: ADDR, VAULT_TOKEN: "wrong", VAULT_TRANSIT_KEY: key })).rejects.toThrow(/403|permission/i);
    await expect(loadKeyProvider({ KEY_PROVIDER: "kms" })).rejects.toThrow(/not known/);
  });
});

describe("Vault provider without a server", () => {
  it("validates its settings", () => {
    expect(() => new VaultTransitKeyProvider({ addr: "vault.local", token: "t", key: "k" })).toThrow(/http/);
    expect(() => new VaultTransitKeyProvider({ addr: "http://v", token: "", key: "k" })).toThrow(/VAULT_TOKEN/);
    expect(() => new VaultTransitKeyProvider({ addr: "http://v", token: "t", key: "bad key!" })).toThrow(/unusual/);
  });
  it("recognises its own blobs only", () => {
    const p = new VaultTransitKeyProvider({ addr: "http://v", token: "t", key: "k" });
    expect(p.keyIdOf("v3.vault-v7.vault:v7:abc")).toBe("vault-v7");
    expect(p.keyIdOf("v2.k1.a.b.c")).toBeNull();
    expect(p.keyIdOf("garbage")).toBeNull();
  });
});
