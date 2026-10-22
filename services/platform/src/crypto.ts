import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
 * replaces it by implementing this interface; nothing else in the platform touches master key material.
 * Wrapped keys carry the id of the key that wrapped them, so several master keys can exist at once (rotation) and an
 * old one can be destroyed once no live data or backup that still needs it remains (see docs/key-management.md).
 */
export interface KeyProvider {
  /** Id of the key used for new wraps. */
  readonly activeId: string;
  /** True for providers that hold key bytes in this process's memory (not an HSM). */
  readonly software: boolean;
  wrap(dek: Buffer, aad: string): string;
  unwrap(blob: string, aad: string): Buffer;
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
  wrap(dek: Buffer, aad: string): string {
    const [, iv, tag, ct] = seal(this.keys[this.activeId], dek, aad).split(".");
    return ["v2", this.activeId, iv, tag, ct].join(".");
  }
  keyIdOf(blob: string): string | null {
    const p = blob.split(".");
    if (p[0] === "v2" && p.length === 5) return p[1];
    return p[0] === "v1" && p.length === 4 ? LEGACY_KEY_ID : null;
  }
  unwrap(blob: string, aad: string): Buffer {
    const id = this.keyIdOf(blob);
    if (!id) throw new Error("unknown wrapped-key format");
    const key = this.keys[id];
    if (!key) throw new Error(`master key "${id}" is not available (destroyed or not loaded)`);
    const p = blob.split(".");
    return open(key, (p[0] === "v2" ? ["v1", ...p.slice(2)] : p).join("."), aad);
  }
}

/**
 * Build the key ring from the environment: MASTER_KEYS="id:hex,id:hex" with MASTER_KEY_ACTIVE=id, or the original single
 * MASTER_KEY_HEX (which is key "k0", so data written before rotation existed still opens).
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
 * Per-member envelope encryption. Each member gets a random data key, wrapped by the KeyProvider (a software key ring
 * today; an HSM-backed provider in production). Erasure = deleting the wrapped key, which makes the stored record
 * unreadable. Copies of the wrapped key in database backups survive the delete, so the erasure guarantee for backups
 * rests on destroying the master key those backups were wrapped under (see docs/key-management.md).
 */
export class KeyStore {
  private provider: KeyProvider;
  constructor(private db: Db, master: Buffer | KeyProvider, readonly pepper: Buffer) {
    if (Buffer.isBuffer(master)) {
      if (master.length !== 32) throw new Error("master key must be 32 bytes");
      this.provider = new SoftwareKeyProvider({ [LEGACY_KEY_ID]: master }, LEGACY_KEY_ID);
    } else this.provider = master;
  }

  get software() { return this.provider.software; }
  get activeKeyId() { return this.provider.activeId; }

  /** Rewrap every data key under the active master key, in batches. Safe to repeat and to run while serving traffic. */
  async rewrapAll(batch = 200): Promise<{ rewrapped: number; remaining: number }> {
    let rewrapped = 0;
    for (;;) {
      const rows = await this.db.query<{ member_id: string; wrapped_key: string }>(
        "SELECT member_id, wrapped_key FROM member_keys WHERE wrapped_key NOT LIKE $1 ORDER BY member_id LIMIT $2", [`v2.${this.provider.activeId}.%`, batch]);
      if (!rows.length) break;
      let progress = 0;
      for (const r of rows) {
        const next = this.provider.wrap(this.provider.unwrap(r.wrapped_key, `wrap:${r.member_id}`), `wrap:${r.member_id}`);
        // Compare-and-swap: if the row changed (or was erased) meanwhile, leave it alone.
        progress += (await this.db.query("UPDATE member_keys SET wrapped_key=$3 WHERE member_id=$1 AND wrapped_key=$2 RETURNING 1", [r.member_id, r.wrapped_key, next])).length;
      }
      rewrapped += progress;
      if (!progress) break;
    }
    const remaining = (await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM member_keys WHERE wrapped_key NOT LIKE $1", [`v2.${this.provider.activeId}.%`]))[0].n;
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

  /** Deterministic keyed hash for lookups (NIN, phone) without storing them in the clear. */
  lookupHash(label: string, value: string): string {
    return createHmac("sha256", this.pepper).update(`${label}:${value}`).digest("hex");
  }

  async createKey(memberId: string, db: Db = this.db): Promise<void> {
    const dek = randomBytes(32);
    await db.query("INSERT INTO member_keys(member_id, wrapped_key) VALUES ($1,$2)", [
      memberId,
      this.provider.wrap(dek, `wrap:${memberId}`),
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

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `${b64(salt)}.${b64(scryptSync(pin, salt, 32))}`;
}

export function checkPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(".");
  const got = scryptSync(pin, Buffer.from(salt, "base64"), 32);
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
