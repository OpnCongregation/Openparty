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

/** Real Postgres when url is given; embedded Postgres (PGlite) otherwise, for dev and tests. */
export async function openDb(url?: string): Promise<Db> {
  const db: Db = url
    ? (() => {
        const pool = new pg.Pool({ connectionString: url });
        return new PgDb(pool, pool);
      })()
    : new PgliteDb(new PGlite());
  await db.exec(SCHEMA);
  return db;
}
