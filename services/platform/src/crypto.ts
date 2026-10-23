import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db.js";

export class ErasedError extends Error {
  constructor() {
    super("record erased: member key destroyed");
  }
}

const b64 = (b: Buffer) => b.toString("base64");

function seal(key: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", b64(iv), b64(c.getAuthTag()), b64(ct)].join(".");
}

function open(key: Buffer, blob: string, aad: string): Buffer {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1") throw new Error("unknown ciphertext version");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]);
}

/**
 * Wraps and unwraps the per-member data keys. This is the only place the master key is used, so an HSM or cloud KMS
 * replaces it by implementing this interface; nothing else in the platform touches master key material. The calls are
 * asynchronous because a real key service is a network call.
 * Wrapped keys carry the id of the key that wrapped them, so several master keys can exist at once (rotation) and an
 * old one can be destroyed once no live data or backup that still needs it remains (see docs/key-management.md).
 * Blob format: `<version>.<key id>.<payload>` (v2 software key ring, v3 Vault Transit); old `v1.` blobs are read as key "k0".
 */
export interface KeyProvider {
  /** Id of the key used for new wraps. */
  readonly activeId: string;
  /** True for providers that hold key bytes in this process's memory (not an HSM or key service). */
  readonly software: boolean;
  wrap(dek: Buffer, aad: string): Promise<string>;
  unwrap(blob: string, aad: string): Promise<Buffer>;
  /** Id of the key a wrapped blob needs, or null if the format is unknown. */
  keyIdOf(blob: string): string | null;
}

const KID = /^[A-Za-z0-9_-]{1,32}$/;
/** Blobs written before key ids existed ("v1.iv.tag.ct") were wrapped by the single master key, which becomes this id. */
export const LEGACY_KEY_ID = "k0";

export class SoftwareKeyProvider implements KeyProvider {
  readonly software = true;
  constructor(private keys: Record<string, Buffer>, readonly activeId: string) {
    for (const [id, k] of Object.entries(keys)) {
      if (!KID.test(id)) throw new Error(`bad master key id "${id}" (letters, digits, - and _ only)`);
      if (k.length !== 32) throw new Error(`master key "${id}" must be 32 bytes`);
    }
    if (!keys[activeId]) throw new Error(`active master key "${activeId}" is not in the key ring`);
  }
  async wrap(dek: Buffer, aad: string): Promise<string> {
    const [, iv, tag, ct] = seal(this.keys[this.activeId], dek, aad).split(".");
    return ["v2", this.activeId, iv, tag, ct].join(".");
  }
  keyIdOf(blob: string): string | null {
    const p = blob.split(".");
    if (p[0] === "v2" && p.length === 5) return p[1];
    return p[0] === "v1" && p.length === 4 ? LEGACY_KEY_ID : null;
  }
  async unwrap(blob: string, aad: string): Promise<Buffer> {
    const id = this.keyIdOf(blob);
    if (!id) throw new Error("unknown wrapped-key format");
    const key = this.keys[id];
    if (!key) throw new Error(`master key "${id}" is not available (destroyed or not loaded)`);
    const p = blob.split(".");
    return open(key, (p[0] === "v2" ? ["v1", ...p.slice(2)] : p).join("."), aad);
  }
}

/**
 * Build the software key ring from the environment: MASTER_KEYS="id:hex,id:hex" with MASTER_KEY_ACTIVE=id, or the original single
 * MASTER_KEY_HEX (which is key "k0", so data written before rotation existed still opens). Vault is built by loadKeyProvider.
 */
export function keyProviderFromEnv(env: Record<string, string | undefined>): KeyProvider | undefined {
  const keys: Record<string, Buffer> = {};
  for (const part of (env.MASTER_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, hex] = part.split(":");
    if (!id || !/^[0-9a-fA-F]{64}$/.test(hex ?? "")) throw new Error(`MASTER_KEYS entry "${id ?? part}" must look like id:<64 hex characters>`);
    if (keys[id]) throw new Error(`MASTER_KEYS lists "${id}" twice`);
    keys[id] = Buffer.from(hex, "hex");
  }
  if (env.MASTER_KEY_HEX) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.MASTER_KEY_HEX)) throw new Error("MASTER_KEY_HEX must be 64 hex characters");
    if (keys[LEGACY_KEY_ID]) throw new Error(`MASTER_KEY_HEX is key "${LEGACY_KEY_ID}" but MASTER_KEYS also defines it`);
    keys[LEGACY_KEY_ID] = Buffer.from(env.MASTER_KEY_HEX, "hex");
  }
  if (!Object.keys(keys).length) return undefined;
  return new SoftwareKeyProvider(keys, env.MASTER_KEY_ACTIVE || (keys[LEGACY_KEY_ID] && !env.MASTER_KEYS ? LEGACY_KEY_ID : Object.keys(keys)[0]));
}

/**
 * Peppers are the secret keys behind the lookup hashes. There are two kinds, on purpose:
 *  - LOOKUP peppers (a ring, one active) hash national IDs and phone numbers so members can be found without storing them.
 *    They can be rotated (rotate-pepper.ts): the hashes live in mutable columns, and lookups try every ring entry meanwhile.
 *  - the REF pepper makes the public-log pseudonyms and the donor keys. These must NOT change casually: the public log is
 *    permanent and the finance ledger is append-only, so a new REF pepper would cut every old pseudonym and donor total off from
 *    new ones. Rotating it is a deliberate act that unlinks the past (see docs/key-management.md).
 */
export interface PepperRing { active: string; keys: Record<string, Buffer>; ref: Buffer }

export function pepperRingFromEnv(env: Record<string, string | undefined>): PepperRing | undefined {
  const keys: Record<string, Buffer> = {};
  for (const part of (env.PEPPERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, hex] = part.split(":");
    if (!id || !KID.test(id) || !/^[0-9a-fA-F]{64}$/.test(hex ?? "")) throw new Error(`PEPPERS entry "${id ?? part}" must look like id:<64 hex characters>`);
    if (keys[id]) throw new Error(`PEPPERS lists "${id}" twice`);
    keys[id] = Buffer.from(hex, "hex");
  }
  if (env.PEPPER_HEX) {
    if (!/^[0-9a-fA-F]{64}$/.test(env.PEPPER_HEX)) throw new Error("PEPPER_HEX must be 64 hex characters");
    if (keys["p0"]) throw new Error('PEPPER_HEX is pepper "p0" but PEPPERS also defines it');
    keys["p0"] = Buffer.from(env.PEPPER_HEX, "hex");
  }
  if (!Object.keys(keys).length) return undefined;
  const active = env.PEPPER_ACTIVE || (keys["p0"] && !env.PEPPERS ? "p0" : Object.keys(keys)[0]);
  if (!keys[active]) throw new Error(`active pepper "${active}" is not in the ring`);
  const refHex = env.REF_PEPPER_HEX || env.PEPPER_HEX;
  if (!refHex) throw new Error("REF_PEPPER_HEX is required when PEPPER_HEX is not set (it makes the public-log pseudonyms and must stay the same)");
  if (!/^[0-9a-fA-F]{64}$/.test(refHex)) throw new Error("REF_PEPPER_HEX must be 64 hex characters");
  return { active, keys, ref: Buffer.from(refHex, "hex") };
}

/**
 * Per-member envelope encryption. Each member gets a random data key, wrapped by the KeyProvider (a software key ring, or
 * Vault Transit where keys never leave the key service). Erasure = deleting the wrapped key, which makes the stored record
 * unreadable. Copies of the wrapped key in database backups survive the delete, so the erasure guarantee for backups
 * rests on destroying the master key those backups were wrapped under (see docs/key-management.md).
 */
export class KeyStore {
  private provider: KeyProvider;
  readonly peppers: PepperRing;
  constructor(private db: Db, master: Buffer | KeyProvider, pepper: Buffer | PepperRing) {
    if (Buffer.isBuffer(master)) {
      if (master.length !== 32) throw new Error("master key must be 32 bytes");
      this.provider = new SoftwareKeyProvider({ [LEGACY_KEY_ID]: master }, LEGACY_KEY_ID);
    } else this.provider = master;
    this.peppers = Buffer.isBuffer(pepper) ? { active: "p0", keys: { p0: pepper }, ref: pepper } : pepper;
  }

  /** The active lookup pepper, for callers that need the raw key (tests). */
  get pepper(): Buffer { return this.peppers.keys[this.peppers.active]; }

  /**
   * Encrypt a short-lived value (for example a pending join) under a fresh data key that is wrapped by the master key.
   * Nothing is stored per member, so there is no key row to delete: the value is simply deleted when it expires.
   */
  async sealTemp(value: unknown, aad: string): Promise<string> {
    const dek = randomBytes(32);
    return `${await this.provider.wrap(dek, aad)}~${seal(dek, Buffer.from(JSON.stringify(value)), aad)}`;
  }

  async openTemp<T = any>(blob: string, aad: string): Promise<T> {
    const [wrapped, sealed] = blob.split("~");
    return JSON.parse(open(await this.provider.unwrap(wrapped, aad), sealed, aad).toString());
  }

  /** The same keys and peppers, reading and writing through another database handle (a transaction). */
  forDb(db: Db): KeyStore { return new KeyStore(db, this.provider, this.peppers); }

  get software() { return this.provider.software; }
  get activeKeyId() { return this.provider.activeId; }

  /** Rewrap every data key under the active master key, in batches. Safe to repeat and to run while serving traffic. */
  async rewrapAll(batch = 200): Promise<{ rewrapped: number; remaining: number }> {
    const current = `v_.${this.provider.activeId}.%`; // v2.<id>.… (software) or v3.<id>.… (Vault)
    let rewrapped = 0;
    for (;;) {
      const rows = await this.db.query<{ member_id: string; wrapped_key: string }>(
        "SELECT member_id, wrapped_key FROM member_keys WHERE wrapped_key NOT LIKE $1 ORDER BY member_id LIMIT $2", [current, batch]);
      if (!rows.length) break;
      let progress = 0;
      for (const r of rows) {
        const aad = `wrap:${r.member_id}`;
        const next = await this.provider.wrap(await this.provider.unwrap(r.wrapped_key, aad), aad);
        // Compare-and-swap: if the row changed (or was erased) meanwhile, leave it alone.
        progress += (await this.db.query("UPDATE member_keys SET wrapped_key=$3 WHERE member_id=$1 AND wrapped_key=$2 RETURNING 1", [r.member_id, r.wrapped_key, next])).length;
      }
      rewrapped += progress;
      if (!progress) break;
    }
    const remaining = (await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM member_keys WHERE wrapped_key NOT LIKE $1", [current]))[0].n;
    return { rewrapped, remaining };
  }

  /** Master key ids still needed by stored data keys, with counts. Destroy a key only when it no longer appears here AND no backup needs it. */
  async keyUsage(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of await this.db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM member_keys")) {
      const id = this.provider.keyIdOf(r.wrapped_key) ?? "unknown";
      out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }

  /** Keyed hash for lookups (NIN, phone) without storing them in the clear: the ACTIVE lookup pepper. Use for writes. */
  lookupHash(label: string, value: string): string {
    return createHmac("sha256", this.pepper).update(`${label}:${value}`).digest("hex");
  }

  /** The same hash under every pepper in the ring (active first). Use for reads, so lookups work while a rotation is under way. */
  lookupCandidates(label: string, value: string): string[] {
    const ids = [this.peppers.active, ...Object.keys(this.peppers.keys).filter((k) => k !== this.peppers.active)];
    return ids.map((id) => createHmac("sha256", this.peppers.keys[id]).update(`${label}:${value}`).digest("hex"));
  }

  /** Keyed hash for values that must stay stable forever: public-log pseudonyms and donor keys (the REF pepper). */
  refHash(label: string, value: string): string {
    return createHmac("sha256", this.peppers.ref).update(`${label}:${value}`).digest("hex");
  }

  async createKey(memberId: string, db: Db = this.db): Promise<void> {
    const dek = randomBytes(32);
    await db.query("INSERT INTO member_keys(member_id, wrapped_key) VALUES ($1,$2)", [
      memberId,
      await this.provider.wrap(dek, `wrap:${memberId}`),
    ]);
  }

  private async dek(memberId: string, db: Db = this.db): Promise<Buffer> {
    const rows = await db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM member_keys WHERE member_id=$1", [memberId]);
    if (!rows.length) throw new ErasedError();
    return this.provider.unwrap(rows[0].wrapped_key, `wrap:${memberId}`);
  }

  async encrypt(memberId: string, value: unknown, db?: Db): Promise<string> {
    return seal(await this.dek(memberId, db), Buffer.from(JSON.stringify(value)), `rec:${memberId}`);
  }

  async decrypt<T = any>(memberId: string, blob: string, db?: Db): Promise<T> {
    return JSON.parse(open(await this.dek(memberId, db), blob, `rec:${memberId}`).toString());
  }

  async shred(memberId: string, db: Db = this.db): Promise<void> {
    await db.query("DELETE FROM member_keys WHERE member_id=$1", [memberId]);
  }
}
// scrypt is deliberately slow (tens of milliseconds). The synchronous form blocks the whole process while it runs, so every
// join and PIN check stalled every other request; the asynchronous form runs on the thread pool. Measured: see docs/load-test.md.
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `${b64(salt)}.${b64(await scryptAsync(pin, salt, 32))}`;
}

export async function checkPin(pin: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(".");
  const got = await scryptAsync(pin, Buffer.from(salt, "base64"), 32);
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

export const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Stable JSON with sorted keys, so the same event always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
