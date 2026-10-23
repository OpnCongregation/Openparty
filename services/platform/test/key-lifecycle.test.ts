import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { ErasedError, KeyStore, pepperRingFromEnv, type PepperRing } from "../src/crypto.js";
import { erasedRefsFromEntries, replayErasures } from "../src/erasure-replay.js";
import { logRef } from "../src/context.js";
import { confirmJoin, erase, prepareJoin, verifyPin } from "../src/members.js";
import { rotatePepper } from "../src/pepper-rotation.js";
import { createCtx } from "../src/platform.js";
import { MemoryTrustLog } from "../src/adapters.js";
import { freshNin, joinAndActivate, makeAdmin } from "./helpers.js";

const hex = () => randomBytes(32).toString("hex");
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as any).code as string);

describe("pepper ring", () => {
  it("reads PEPPERS / PEPPER_ACTIVE, treats PEPPER_HEX as p0, and refuses malformed or unsafe settings", () => {
    const a = hex(), b = hex();
    const legacy = pepperRingFromEnv({ PEPPER_HEX: a })!;
    expect(legacy.active).toBe("p0");
    expect(legacy.ref.toString("hex")).toBe(a);
    const ring = pepperRingFromEnv({ PEPPER_HEX: a, PEPPERS: `p1:${b}`, PEPPER_ACTIVE: "p1" })!;
    expect(ring.active).toBe("p1");
    expect(Object.keys(ring.keys).sort()).toEqual(["p0", "p1"]);
    expect(ring.ref.toString("hex")).toBe(a); // the public-reference pepper stays the original
    expect(pepperRingFromEnv({})).toBeUndefined();
    expect(() => pepperRingFromEnv({ PEPPERS: `p1:${b}` })).toThrow(/REF_PEPPER_HEX is required/);
    expect(() => pepperRingFromEnv({ PEPPERS: "p1:short", REF_PEPPER_HEX: a })).toThrow(/64 hex/);
    expect(() => pepperRingFromEnv({ PEPPERS: `p1:${b}`, PEPPER_ACTIVE: "nope", REF_PEPPER_HEX: a })).toThrow(/not in the ring/);
    expect(() => pepperRingFromEnv({ PEPPER_HEX: a, PEPPERS: `p0:${b}` })).toThrow(/also defines/);
  });
});

describe("F-14: pepper rotation", () => {
  async function world() {
    const master = hex(), p0 = hex(), p1 = hex();
    const ring0: PepperRing = { active: "p0", keys: { p0: Buffer.from(p0, "hex") }, ref: Buffer.from(p0, "hex") };
    const ring01: PepperRing = { active: "p1", keys: { p0: Buffer.from(p0, "hex"), p1: Buffer.from(p1, "hex") }, ref: Buffer.from(p0, "hex") };
    const ring1: PepperRing = { active: "p1", keys: { p1: Buffer.from(p1, "hex") }, ref: Buffer.from(p0, "hex") };
    const log = new MemoryTrustLog();
    const ctx = await createCtx({ masterKeyHex: master, peppers: ring0, log });
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const old = await joinAndActivate(ctx, agent);
    const use = (ring: PepperRing) => { ctx.keys = new KeyStore(ctx.db, Buffer.from(master, "hex"), ring); };
    return { ctx, agent, old, use, ring0, ring01, ring1, log };
  }

  it("works before, during and after: duplicates refused and PIN checks find the member throughout", async () => {
    const { ctx, agent, old, use, ring01, ring1 } = await world();
    const refBefore = logRef(ctx, "member", old.memberId);

    use(ring01); // a new pepper is added and made active; the old one stays in the ring
    expect(await code(prepareJoin(ctx, "+2348055501111", old.nin))).toBe("id_in_use"); // found through the old pepper
    expect((await verifyPin(ctx, old.phone, "1234")).id).toBe(old.memberId);
    const fresh = await joinAndActivate(ctx, agent); // new members are stored under the new pepper
    const row = (await ctx.db.query<{ id_hash: string }>("SELECT id_hash FROM members WHERE id=$1", [fresh.memberId]))[0];
    expect(row.id_hash).toBe(ctx.keys.lookupHash("id", fresh.nin));

    const r = await rotatePepper(ctx);
    expect(r).toMatchObject({ rehashed: 1, alreadyCurrent: 1, conflicts: 0 }); // the old member moved; the new one was already current
    const moved = (await ctx.db.query<{ id_hash: string; phone_hash: string }>("SELECT id_hash, phone_hash FROM members WHERE id=$1", [old.memberId]))[0];
    expect(moved).toEqual({ id_hash: ctx.keys.lookupHash("id", old.nin), phone_hash: ctx.keys.lookupHash("phone", old.phone) });
    expect(await rotatePepper(ctx)).toMatchObject({ rehashed: 0, alreadyCurrent: 2 }); // idempotent

    use(ring1); // the old pepper is dropped
    expect(await code(prepareJoin(ctx, "+2348055502222", old.nin))).toBe("id_in_use");
    expect((await verifyPin(ctx, old.phone, "1234")).id).toBe(old.memberId);
    expect(logRef(ctx, "member", old.memberId)).toBe(refBefore); // public pseudonyms did not change
  });

  it("without rotating first, dropping the old pepper loses the member (the reason the tool exists)", async () => {
    const { ctx, old, use, ring1 } = await world();
    use(ring1);
    expect(await code(verifyPin(ctx, old.phone, "1234"))).toBe("no_member");
    expect(await code(prepareJoin(ctx, "+2348055503333", old.nin))).toBe("ok"); // duplicate NIN no longer detected
  });

  it("skips erased members, and a rejoin under the new pepper keeps one membership per ID", async () => {
    const { ctx, agent, old, use, ring01 } = await world();
    const gone = await joinAndActivate(ctx, agent);
    await erase(ctx, gone.memberId);
    use(ring01);
    const r = await rotatePepper(ctx);
    expect(r.rehashed).toBe(1);
    expect(r.skipped).toBe(0); // erased members are filtered out by the query, not decrypted
    // resign + rejoin with the same NIN while both peppers are present
    const { resign } = await import("../src/members.js");
    await resign(ctx, old.memberId);
    await prepareJoin(ctx, old.phone, old.nin);
    await confirmJoin(ctx, old.phone, "visible", "4321");
    expect((await ctx.db.query("SELECT 1 FROM members WHERE id_hash = ANY($1)", [ctx.keys.lookupCandidates("id", old.nin)])).length).toBe(1);
  });
});

describe("F-14: erasures survive a restore", () => {
  it("a key row restored from backup reopens an erased record until the public log's erasures are replayed", async () => {
    const log = new MemoryTrustLog();
    const ctx = await createCtx({ masterKeyHex: hex(), pepperHex: hex(), log });
    const agent = await makeAdmin(ctx, "ward_agent", "W1");
    const keep = await joinAndActivate(ctx, agent);
    const gone = await joinAndActivate(ctx, agent);

    // The backup: taken while both members existed.
    const backupKeys = await ctx.db.query<{ member_id: string; wrapped_key: string }>("SELECT * FROM member_keys WHERE member_id = ANY($1)", [[keep.memberId, gone.memberId]]);
    const backupMember = (await ctx.db.query<any>("SELECT * FROM members WHERE id=$1", [gone.memberId]))[0];
    const record = backupMember.record_enc as string;

    await erase(ctx, gone.memberId); // erased after the backup was taken
    await expect(ctx.keys.decrypt(gone.memberId, record)).rejects.toBeInstanceOf(ErasedError);

    // Restore: key row and member row come back as they were in the backup.
    await ctx.db.query("INSERT INTO member_keys(member_id, wrapped_key) VALUES ($1,$2)", [gone.memberId, backupKeys.find((k) => k.member_id === gone.memberId)!.wrapped_key]);
    await ctx.db.query("UPDATE members SET state=$2, pin_hash=$3, phone_hash=$4, id_hash=$5 WHERE id=$1", [gone.memberId, backupMember.state, backupMember.pin_hash, backupMember.phone_hash, backupMember.id_hash]);
    expect((await ctx.keys.decrypt<any>(gone.memberId, record)).national_id).toBe(gone.nin); // the known limit, shown

    const entries = log.events.map((e) => Buffer.from(JSON.stringify({ type: e.type, data: e.data, oid: e.oid })));
    const refs = erasedRefsFromEntries(entries);
    expect(refs.size).toBe(1);
    expect(await replayErasures(ctx, refs)).toMatchObject({ replayed: 1 });

    await expect(ctx.keys.decrypt(gone.memberId, record)).rejects.toBeInstanceOf(ErasedError); // unreadable again
    expect((await ctx.db.query("SELECT state, id_hash FROM members WHERE id=$1", [gone.memberId]))[0]).toMatchObject({ state: "erased", id_hash: `erased:${gone.memberId}` });
    expect((await ctx.keys.decrypt<any>(keep.memberId, (await ctx.db.query<any>("SELECT record_enc FROM members WHERE id=$1", [keep.memberId]))[0].record_enc)).national_id).toBe(keep.nin); // others untouched
    expect(await replayErasures(ctx, refs)).toMatchObject({ replayed: 0 }); // repeating does nothing
  });

  it("ignores log entries that are not erasures or cannot be read", () => {
    const refs = erasedRefsFromEntries([Buffer.from("not json"), Buffer.from(JSON.stringify({ type: "member.joined", data: { member_ref: "a".repeat(24) } })), Buffer.from(JSON.stringify({ type: "member.erased", data: { member_ref: "b".repeat(24) } }))]);
    expect([...refs]).toEqual(["b".repeat(24)]);
  });
});
