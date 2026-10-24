/**
 * The platform's client for the ElectionGuard service (services/electionguard). The service holds no state and no guardian secrets:
 * every call carries everything it needs. Only PUBLIC data goes through it (manifest, public keys, ciphertexts, shares of the total).
 * The one exception is encryption of a ballot for a voter who cannot encrypt on their own device (a USSD or in-person voter), where the
 * plaintext choice passes through this process in memory for that call and is never stored. See docs/secret-ballot-recommendation.md.
 */
export interface ElectionSpec {
  id: string; name: string; start: string; end: string;
  contests: { id: string; title: string; candidates: { id: string; name: string }[] }[];
}

export interface Submission { guardian_id: string; share: string; compensated: Record<string, string> }

export interface EgClient {
  manifest(election: ElectionSpec): Promise<{ manifest: string; manifest_hash: string }>;
  combineKeys(publicKeys: string[], n: number, quorum: number): Promise<{ joint_public_key: string }>;
  context(manifest: string, jointPublicKey: string, n: number, quorum: number): Promise<{ context: string }>;
  encrypt(manifest: string, context: string, ballotId: string, choices: Record<string, string | null>): Promise<{ ballot: string; ballot_code: string }>;
  checkBallot(manifest: string, context: string, ballot: string): Promise<boolean>;
  tally(manifest: string, context: string, ballots: string[], previous?: string): Promise<{ tally: string; added: number; count: number }>;
  decrypt(manifest: string, context: string, tally: string, publicKeys: string[], submissions: Submission[]):
    Promise<{ counts: Record<string, Record<string, number>>; plaintext_tally: string; guardians_present: string[]; guardians_absent: string[] }>;
  verify(manifest: string, context: string, ballots: string[], tally: string): Promise<{ ok: boolean; problems: string[]; ballots: number }>;
  /** DEMO ONLY (the service serves these only when EG_ENABLE_GUARDIAN_OPS=1): a real guardian runs these on their own device. */
  guardian?: {
    init(id: string, sequenceOrder: number, n: number, quorum: number): Promise<{ private: string; public: string }>;
    backups(priv: string, publicKeys: string[]): Promise<{ private: string; backups: string[] }>;
    receive(priv: string, backups: string[]): Promise<{ private: string; verifications: { from: string; verified: boolean }[]; all_verified: boolean }>;
    shares(priv: string, manifest: string, context: string, tally: string, publicKeys: string[]): Promise<Submission>;
  };
}

export class EgError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export class HttpEgClient implements EgClient {
  guardian?: EgClient["guardian"];
  constructor(private url: string, private token: string, opts: { guardianOps?: boolean } = {}) {
    if (!/^https?:\/\//.test(url)) throw new Error("EG_URL must start with http:// or https://");
    if (opts.guardianOps) {
      this.guardian = {
        init: (id, sequenceOrder, n, quorum) => this.post("guardian/init", { id, sequence_order: sequenceOrder, n, quorum }),
        backups: (priv, publicKeys) => this.post("guardian/backups", { private: priv, public_keys: publicKeys }),
        receive: (priv, backups) => this.post("guardian/receive", { private: priv, backups }),
        shares: (priv, manifest, context, tally, publicKeys) => this.post("guardian/shares", { private: priv, manifest, context, tally, public_keys: publicKeys }),
      };
    }
  }

  private async post<T>(op: string, body: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.url.replace(/\/$/, "")}/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60_000), // encrypting or tallying thousands of ballots in Python takes a while
      });
    } catch (e: any) {
      throw new EgError(503, "eg_unavailable", `The ballot-encryption service could not be reached: ${e?.message ?? e}`);
    }
    const text = await r.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!r.ok) throw new EgError(r.status, json.error ?? "eg_error", json.message ?? `ballot-encryption service said ${r.status}`);
    return json as T;
  }

  manifest(election: ElectionSpec) { return this.post<{ manifest: string; manifest_hash: string }>("manifest", { election }); }
  combineKeys(publicKeys: string[], n: number, quorum: number) { return this.post<{ joint_public_key: string }>("combine-keys", { public_keys: publicKeys, n, quorum }); }
  context(manifest: string, jointPublicKey: string, n: number, quorum: number) { return this.post<{ context: string }>("context", { manifest, joint_public_key: jointPublicKey, n, quorum }); }
  encrypt(manifest: string, context: string, ballotId: string, choices: Record<string, string | null>) { return this.post<{ ballot: string; ballot_code: string }>("encrypt", { manifest, context, ballot_id: ballotId, choices }); }
  async checkBallot(manifest: string, context: string, ballot: string) { return (await this.post<{ ok: boolean }>("check-ballot", { manifest, context, ballot })).ok; }
  tally(manifest: string, context: string, ballots: string[], previous?: string) { return this.post<{ tally: string; added: number; count: number }>("tally", { manifest, context, ballots, previous }); }
  decrypt(manifest: string, context: string, tally: string, publicKeys: string[], submissions: Submission[]) { return this.post<any>("decrypt", { manifest, context, tally, public_keys: publicKeys, submissions }); }
  verify(manifest: string, context: string, ballots: string[], tally: string) { return this.post<{ ok: boolean; problems: string[]; ballots: number }>("verify", { manifest, context, ballots, tally }); }
}
