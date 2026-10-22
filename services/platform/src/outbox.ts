import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { LogEvent, TrustLog } from "./adapters.js";
import { assertPublicLogSafe } from "./adapters.js";

// Why this exists: a domain change and its public-log event used to be two separate steps, so a crash between them left a
// row with no event (or, when the event was written first, an event with no row). Now the event is inserted into
// `log_outbox` inside the SAME database transaction as the change, so they commit or roll back together, and a publisher
// copies committed events to the log in order. Publishing twice is harmless because the log ignores a repeated `oid`.

/** Advisory lock key: one publisher at a time, across instances, keeps the log in commit order. */
const LOCK_NAME = "openparty:outbox"; // hashed with the schema name, so databases sharing a server (tests) do not block each other
const BATCH = 200;

export interface OutboxStats {
  pending: number;
  oldestPendingSeconds: number | null;
  lastError: string | null;
}

export class Outbox {
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  /** Last publish error seen by this process, for health reporting. */
  lastError: string | null = null;

  constructor(private db: Db, private sink: TrustLog) {}

  /**
   * Queue an event on the caller's transaction handle. The event is checked against the public-log allowlist NOW, so an
   * event that could never be published fails the transaction instead of sitting in the outbox forever.
   */
  async emit(tx: Db, e: LogEvent): Promise<void> {
    assertPublicLogSafe(e);
    await tx.query("INSERT INTO log_outbox(oid,type,data,at) VALUES ($1,$2,$3,$4)", [randomUUID(), e.type, JSON.stringify(e.data), new Date().toISOString()]);
  }

  /** Publish everything committed so far. Calls queue up, so when this resolves your own event has had its turn. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.drain());
    this.chain = run.catch(() => undefined);
    return run.catch((e) => {
      this.lastError = String(e?.message ?? e).slice(0, 200);
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if ((await this.publishBatch()) < BATCH) return; // a full batch means there may be more
    }
  }

  /** One batch in one transaction under the advisory lock. Returns how many events were published. */
  private async publishBatch(): Promise<number> {
    return this.db.tx(async (tx) => {
      const got = await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext(current_schema() || $1)) AS ok", [LOCK_NAME]);
      if (!got[0]?.ok) return 0; // another instance is publishing; it will take our rows too
      const rows = await tx.query<{ seq: number; oid: string; type: string; data: string; at: string }>(
        "SELECT seq, oid, type, data, at FROM log_outbox WHERE published_at IS NULL ORDER BY seq LIMIT $1", [BATCH]);
      let published = 0;
      for (const r of rows) {
        try {
          await this.sink.append({ type: r.type, data: JSON.parse(r.data), at: new Date(r.at).toISOString(), oid: r.oid });
        } catch (e: any) {
          // Stop at the first failure: later events must not overtake it.
          this.lastError = String(e?.message ?? e).slice(0, 200);
          await tx.query("UPDATE log_outbox SET attempts=attempts+1, last_error=$2 WHERE seq=$1", [r.seq, this.lastError]);
          break;
        }
        await tx.query("UPDATE log_outbox SET published_at=now(), last_error=NULL WHERE seq=$1", [r.seq]);
        published++;
      }
      if (published === rows.length) this.lastError = null;
      return published === rows.length ? published : -1; // -1: stopped early, do not loop on a failing sink
    });
  }

  /** Background publisher: heals the gap left by a crash between commit and publish. */
  start(everyMs = 500) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), everyMs);
    this.timer.unref?.();
    void this.flush();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async stats(): Promise<OutboxStats> {
    const r = await this.db.query<{ n: number; age: number | null }>(
      "SELECT COUNT(*)::int AS n, EXTRACT(EPOCH FROM (now() - MIN(at)))::float8 AS age FROM log_outbox WHERE published_at IS NULL");
    return { pending: r[0].n, oldestPendingSeconds: r[0].n ? r[0].age : null, lastError: this.lastError };
  }
}
