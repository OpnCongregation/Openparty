import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { SCHEMA } from "./schema.js";

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<R>(fn: (d: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

class PgliteDb implements Db {
  constructor(private db: PGlite | any) {}
  async query<T>(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as T[];
  }
  async exec(sql: string) {
    await this.db.exec(sql);
  }
  async tx<R>(fn: (d: Db) => Promise<R>) {
    return this.db.transaction((t: any) => fn(new PgliteDb(t)));
  }
  async close() {
    if (this.db.close) await this.db.close();
  }
}

class PgDb implements Db {
  constructor(private q: pg.Pool | pg.PoolClient, private pool?: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []) {
    return (await this.q.query(sql, params as any[])).rows as T[];
  }
  async exec(sql: string) {
    await this.q.query(sql);
  }
  async tx<R>(fn: (d: Db) => Promise<R>) {
    const c = await (this.q as pg.Pool).connect();
    try {
      await c.query("BEGIN");
      const r = await fn(new PgDb(c));
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async close() {
    await this.pool?.end();
  }
}

/**
 * Real Postgres when url is given; embedded Postgres (PGlite) otherwise, for dev and tests.
 * `schema` (tests only) puts everything in its own Postgres schema, so many test databases can share one server.
 */
export async function openDb(url?: string, opts: { schema?: string } = {}): Promise<Db> {
  if (url && opts.schema) {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(opts.schema)) throw new Error("bad schema name");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${opts.schema}`); } finally { await admin.end(); }
  }
  const db: Db = url
    ? (() => {
        const pool = new pg.Pool({
          connectionString: url,
          ...(opts.schema ? { options: `-c search_path=${opts.schema}`, max: 4, idleTimeoutMillis: 1000 } : {}),
        });
        // An idle connection that dies (database restarted, network cut) emits "error" on the pool. With no listener Node
        // treats that as fatal and the whole platform exits; log it and let the pool open a fresh connection instead.
        pool.on("error", (e) => console.error("postgres: idle connection error (will reconnect):", e.message));
        return new PgDb(pool, pool);
      })()
    : new PgliteDb(new PGlite());
  await db.exec(SCHEMA);
  return db;
}
