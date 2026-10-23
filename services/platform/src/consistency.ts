import type { Db } from "./db.js";

export interface ConsistencyReport {
  ok: boolean;
  problems: string[];
  notes: string[];
  stats: { outboxPublished: number; outboxPending: number; logEntries: number; logEntriesWithoutKey: number };
}

/** Everything the log serves, one page at a time (the log caps a page; `next` says where the following one starts). */
export async function readAllEntries(logUrl: string, fetchFn: typeof fetch = fetch): Promise<Buffer[]> {
  const base = logUrl.replace(/\/$/, "");
  const out: Buffer[] = [];
  let next = 0;
  for (;;) {
    const r = await fetchFn(`${base}/entries?from=${next}`);
    if (!r.ok) throw new Error(`log /entries?from=${next} answered ${r.status}`);
    const page = (await r.json()) as { entries: string[]; next: number; size: number };
    for (const e of page.entries) out.push(Buffer.from(e, "base64"));
    next = page.next;
    if (next >= page.size) return out;
    if (!page.entries.length) throw new Error(`log returned no entries at ${next} although its size is ${page.size}`);
  }
}

/**
 * Compare the database's outbox with what the public log really contains. Finds: events that were committed and marked
 * published but are not in the log, log entries nobody committed, a key used twice, events stuck unpublished, and approvals
 * stuck half-executed. It only reads.
 */
export async function verifyConsistency(db: Db, entries: Buffer[], opts: { maxPendingSeconds?: number } = {}): Promise<ConsistencyReport> {
  const maxPending = opts.maxPendingSeconds ?? 120;
  const problems: string[] = [];
  const notes: string[] = [];

  const inLog = new Map<string, number>();
  let withoutKey = 0;
  entries.forEach((b, i) => {
    let oid: unknown;
    try { oid = JSON.parse(b.toString("utf8"))?.oid; } catch { oid = undefined; }
    if (typeof oid !== "string") { withoutKey++; return; }
    if (inLog.has(oid)) problems.push(`log entries ${inLog.get(oid)} and ${i} carry the same key ${oid} (the log should have refused the second)`);
    else inLog.set(oid, i);
  });

  const rows = await db.query<{ oid: string; type: string; published: boolean; age: number }>(
    "SELECT oid, type, (published_at IS NOT NULL) AS published, EXTRACT(EPOCH FROM (now() - at))::float8 AS age FROM log_outbox ORDER BY seq");
  const known = new Set<string>();
  let published = 0, pending = 0;
  for (const r of rows) {
    known.add(r.oid);
    if (r.published) {
      published++;
      if (!inLog.has(r.oid)) problems.push(`event ${r.type} (${r.oid}) is marked published but is not in the log`);
    } else {
      pending++;
      if (inLog.has(r.oid)) notes.push(`event ${r.type} (${r.oid}) is in the log but not yet marked published (a crash between the two; the next publish run fixes it)`);
      else if (r.age > maxPending) problems.push(`event ${r.type} (${r.oid}) has waited ${Math.round(r.age)}s to be published`);
    }
  }
  for (const [oid, i] of inLog) if (!known.has(oid)) problems.push(`log entry ${i} (key ${oid}) has no matching outbox row: nobody on this database committed it`);

  const stuck = await db.query<{ id: string; action: string; age: number }>(
    "SELECT id, action, EXTRACT(EPOCH FROM (now() - created_at))::float8 AS age FROM approvals WHERE status='executing'");
  for (const s of stuck) {
    if (s.age > maxPending) problems.push(`approval ${s.id} (${s.action}) is stuck in 'executing': the action may have run without being marked done`);
  }
  // Every money row must have its public event. Rows older than the first outbox event predate the outbox: reported, not an error.
  const first = (await db.query<{ t: string | null }>("SELECT MIN(at) AS t FROM log_outbox"))[0].t;
  const ledger = await db.query<{ id: number; kind: string; at: string; has: boolean }>(
    `SELECT l.id::int AS id, l.kind, l.at, EXISTS (SELECT 1 FROM log_outbox o WHERE o.type = 'finance.' || l.kind AND (o.data::jsonb ->> 'ledger_id') = l.id::text) AS has FROM finance_ledger l ORDER BY l.id`);
  for (const l of ledger) {
    if (l.has) continue;
    if (first && new Date(l.at) < new Date(first)) notes.push(`ledger row ${l.id} (${l.kind}) predates the outbox and has no matching event`);
    else problems.push(`ledger row ${l.id} (${l.kind}) has no public finance.${l.kind} event`);
  }
  if (withoutKey) notes.push(`${withoutKey} log entries have no key (written before the outbox existed); they cannot be matched`);

  return { ok: problems.length === 0, problems, notes, stats: { outboxPublished: published, outboxPending: pending, logEntries: entries.length, logEntriesWithoutKey: withoutKey } };
}
