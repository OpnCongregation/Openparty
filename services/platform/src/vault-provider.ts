import type { KeyProvider } from "./crypto.js";
import { keyProviderFromEnv } from "./crypto.js";

/**
 * Master keys held in HashiCorp Vault's Transit engine (or OpenBao, which has the same API). The key never leaves Vault: this
 * process sends a data key to be encrypted and gets ciphertext back, so a stolen database, a stolen platform host or a stolen .env
 * file does not contain the master key. Rotating the key is a Vault operation, and destroying an old version (raising its
 * minimum decryption version) is what makes backups wrapped under it permanently unreadable.
 *
 * The transit key must be created with `derived=true`: the data key's identity (`wrap:<member id>`) is sent as the derivation
 * context, so a wrapped key copied onto another member's row will not unwrap. Without that the binding would silently be lost,
 * so the provider refuses to start against a key that is not derived.
 *
 * Blob format: `v3.vault-v<N>.<vault ciphertext>` where <N> is the key version that encrypted it.
 */
export interface VaultConfig {
  addr: string;
  token: string;
  /** Transit key name. */
  key: string;
  namespace?: string;
  /** Create the transit mount and key if missing. For development servers only. */
  createIfMissing?: boolean;
  fetchFn?: typeof fetch;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

export class VaultTransitKeyProvider implements KeyProvider {
  readonly software = false;
  private latest = 1;
  private f: typeof fetch;
  constructor(private cfg: VaultConfig) {
    this.f = cfg.fetchFn ?? fetch;
    if (!/^https?:\/\//.test(cfg.addr)) throw new Error("VAULT_ADDR must start with http:// or https://");
    if (!cfg.token) throw new Error("VAULT_TOKEN is required");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(cfg.key)) throw new Error("VAULT_TRANSIT_KEY has unusual characters");
  }

  get activeId(): string { return `vault-v${this.latest}`; }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.f(`${this.cfg.addr.replace(/\/$/, "")}/v1/${path}`, {
      method,
      headers: { "X-Vault-Token": this.cfg.token, "content-type": "application/json", ...(this.cfg.namespace ? { "X-Vault-Namespace": this.cfg.namespace } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!r.ok) throw new Error(`vault ${method} ${path}: ${r.status} ${(json.errors ?? [text]).join("; ").slice(0, 200)}`);
    return json;
  }

  /** Check the key (and create it first on a dev server), and learn its latest version. Call once at start. */
  async init(): Promise<this> {
    if (this.cfg.createIfMissing) {
      try { await this.call("POST", "sys/mounts/transit", { type: "transit" }); } catch (e: any) { if (!/already in use|existing mount/i.test(String(e.message))) throw e; }
      try { await this.call("GET", `transit/keys/${this.cfg.key}`); } catch { await this.call("POST", `transit/keys/${this.cfg.key}`, { derived: true, type: "aes256-gcm96" }); }
    }
    await this.refresh();
    return this;
  }

  /** Re-read the key's latest version (after a rotation done elsewhere). */
  async refresh(): Promise<void> {
    const info = (await this.call("GET", `transit/keys/${this.cfg.key}`)).data;
    if (!info.derived) throw new Error(`transit key "${this.cfg.key}" is not derived: create it with derived=true so wrapped keys are bound to their member`);
    if (info.type && !String(info.type).startsWith("aes256-gcm96") && !String(info.type).startsWith("chacha20")) throw new Error(`transit key type ${info.type} is not an encryption key`);
    this.latest = Number(info.latest_version);
  }

  /** Make a new key version. New wraps use it at once; run rotate-keys to rewrap existing data keys. */
  async rotateKey(): Promise<number> {
    await this.call("POST", `transit/keys/${this.cfg.key}/rotate`);
    await this.refresh();
    return this.latest;
  }

  /**
   * Destroy old versions: Vault refuses to decrypt anything wrapped by a version below `min`, and `trim` then deletes them for
   * good. Only do this once no live row AND no backup that must stay restorable needs them (docs/key-management.md).
   */
  async destroyVersionsBelow(min: number): Promise<void> {
    await this.call("POST", `transit/keys/${this.cfg.key}/config`, { min_decryption_version: min, min_encryption_version: min });
    await this.call("POST", `transit/keys/${this.cfg.key}/trim`, { min_available_version: min });
  }

  async wrap(dek: Buffer, aad: string): Promise<string> {
    const r = await this.call("POST", `transit/encrypt/${this.cfg.key}`, { plaintext: b64(dek), context: b64(aad) });
    const ct = String(r.data.ciphertext); // vault:v<N>:<base64>
    const ver = /^vault:v(\d+):/.exec(ct)?.[1];
    if (!ver) throw new Error("unexpected ciphertext from vault");
    return `v3.vault-v${ver}.${ct}`;
  }

  keyIdOf(blob: string): string | null {
    const p = blob.split(".");
    return p[0] === "v3" && p.length >= 3 && /^vault-v\d+$/.test(p[1]) ? p[1] : null;
  }

  async unwrap(blob: string, aad: string): Promise<Buffer> {
    if (!this.keyIdOf(blob)) throw new Error("unknown wrapped-key format");
    const ct = blob.split(".").slice(2).join(".");
    let r: any;
    try { r = await this.call("POST", `transit/decrypt/${this.cfg.key}`, { ciphertext: ct, context: b64(aad) }); }
    catch (e: any) { throw new Error(`master key "${blob.split(".")[1]}" could not unwrap this data key (destroyed, wrong member, or vault unavailable): ${e.message}`); }
    return Buffer.from(r.data.plaintext, "base64");
  }
}

/** Build the key provider the environment asks for: Vault when KEY_PROVIDER=vault, otherwise the software key ring. */
export async function loadKeyProvider(env: Record<string, string | undefined>): Promise<KeyProvider | undefined> {
  if (env.KEY_PROVIDER === "vault") {
    return new VaultTransitKeyProvider({
      addr: env.VAULT_ADDR ?? "", token: env.VAULT_TOKEN ?? "", key: env.VAULT_TRANSIT_KEY ?? "openparty-master",
      namespace: env.VAULT_NAMESPACE || undefined, createIfMissing: env.VAULT_CREATE_IF_MISSING === "1",
    }).init();
  }
  if (env.KEY_PROVIDER && env.KEY_PROVIDER !== "software") throw new Error(`KEY_PROVIDER "${env.KEY_PROVIDER}" is not known (software or vault)`);
  return keyProviderFromEnv(env);
}
