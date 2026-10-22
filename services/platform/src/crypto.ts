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
 * Per-member envelope encryption. Each member gets a random data key, wrapped under a master key
 * (a software stand-in for the HSM; swap `master` for an HSM-backed wrapper in production).
 * Erasure = deleting the wrapped key, which makes the stored record unreadable forever.
 */
export class KeyStore {
  constructor(private db: Db, private master: Buffer, readonly pepper: Buffer) {
    if (master.length !== 32) throw new Error("master key must be 32 bytes");
  }

  /** Deterministic keyed hash for lookups (NIN, phone) without storing them in the clear. */
  lookupHash(label: string, value: string): string {
    return createHmac("sha256", this.pepper).update(`${label}:${value}`).digest("hex");
  }

  async createKey(memberId: string, db: Db = this.db): Promise<void> {
    const dek = randomBytes(32);
    await db.query("INSERT INTO member_keys(member_id, wrapped_key) VALUES ($1,$2)", [
      memberId,
      seal(this.master, dek, `wrap:${memberId}`),
    ]);
  }

  private async dek(memberId: string, db: Db = this.db): Promise<Buffer> {
    const rows = await db.query<{ wrapped_key: string }>("SELECT wrapped_key FROM member_keys WHERE member_id=$1", [memberId]);
    if (!rows.length) throw new ErasedError();
    return open(this.master, rows[0].wrapped_key, `wrap:${memberId}`);
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
