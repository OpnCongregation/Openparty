import type { Db } from "./db.js";

export interface Limiter {
  /** True if this request is allowed (and counts it). */
  take(key: string): Promise<boolean>;
}

/** Sliding-window counter held in this process's memory. Cheap, but private to one process and lost on restart. */
export class MemoryLimiter implements Limiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}
  async take(key: string): Promise<boolean> {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.sweep(t);
    return true;
  }
  private sweep(t: number) {
    for (const [k, v] of this.hits) if (!v.length || t - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
    // Still huge (a flood of distinct keys): drop everything rather than grow without bound.
    if (this.hits.size > 50_000) this.hits.clear();
  }
}

/**
 * Counter shared by every platform instance through the database, and kept across restarts. Two fixed windows are
 * blended (the previous window counts for the part of it still inside the last `windowMs`), which removes the burst a
 * plain fixed window allows at its edge. One upsert per request; old windows are deleted as new ones are written.
 */
export class PgLimiter implements Limiter {
  private calls = 0;
  private table: string;
  /**
   * durable: true keeps the counters in a crash-durable (LOGGED) table. Use it for anything an attacker would profit from
   * resetting (failed authentication). Volume throttles may use the default UNLOGGED table: losing them only grants one more
   * window of ordinary traffic.
   */
  constructor(private db: Db, private scope: string, private max: number, private windowMs: number, private now: () => number = Date.now, opts: { durable?: boolean } = {}) {
    this.table = opts.durable ? "rate_limits_durable" : "rate_limits";
  }

  async take(key: string): Promise<boolean> {
    const t = this.now();
    const w = Math.floor(t / this.windowMs);
    const k = `${this.scope}:${key}`;
    const cur = (await this.db.query<{ n: number }>(
      `INSERT INTO ${this.table}(key,window_start,n) VALUES ($1,$2,1)
       ON CONFLICT (key,window_start) DO UPDATE SET n = ${this.table}.n + 1 RETURNING n`, [k, w]))[0].n;
    const prevRow = await this.db.query<{ n: number }>(`SELECT n FROM ${this.table} WHERE key=$1 AND window_start=$2`, [k, w - 1]);
    const prev = prevRow.length ? prevRow[0].n : 0;
    const frac = (t % this.windowMs) / this.windowMs; // how far into the current window we are
    if (++this.calls % 500 === 0) void this.db.query(`DELETE FROM ${this.table} WHERE window_start < $1`, [w - 1]).catch(() => undefined);
    return prev * (1 - frac) + cur <= this.max;
  }
}

/**
 * Local check first, then the shared one. The local check rejects a flood without a database round trip; the shared
 * one is what makes the limit hold across instances and restarts. If the shared store fails, the local answer stands
 * (the request would normally fail on the same database a moment later anyway).
 */
export class LayeredLimiter implements Limiter {
  constructor(private local: Limiter, private shared: Limiter) {}
  async take(key: string): Promise<boolean> {
    if (!(await this.local.take(key))) return false;
    try {
      return await this.shared.take(key);
    } catch {
      return true;
    }
  }
}
