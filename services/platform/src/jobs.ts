import type { Ctx } from "./context.js";
import type { ModuleName } from "./framework/modules.js";
import { recoverApprovals } from "./admin.js";
import { sendRecordNotices } from "./record-notices.js";

export interface Job {
  name: string;
  /** The optional module this job belongs to, or null for a core job that always runs. */
  module: ModuleName | null;
  everySeconds: number;
  run: (ctx: Ctx) => Promise<void>;
}

const env = (k: string, d: number) => Number(process.env[k] ?? d);

/**
 * Every background job the platform starts. Approval recovery and record notices belong to the core (approvals, and the
 * register that the law requires before any contest), so they run whatever the modules say. A job that belongs to an
 * optional module names it here and only runs while that module is on. (The outbox publisher is core too; see outbox.ts.)
 */
export const JOBS: Job[] = [
  {
    name: "approval recovery", module: null, everySeconds: env("APPROVAL_RECOVERY_SECONDS", 30),
    // Finish approvals whose executor died between claiming and applying them (at startup, then repeatedly; safe on every instance).
    run: async (ctx) => {
      const r = await recoverApprovals(ctx, Number(process.env.APPROVAL_LEASE_SECONDS ?? 60));
      if (r.recovered || r.failed) console.log(`approvals: recovered ${r.recovered}, gave up on ${r.failed}`);
    },
  },
  {
    name: "record notices", module: null, everySeconds: env("RECORD_NOTICE_SECONDS", 3600),
    // Tell members with incomplete records (and repeat the reminders as the register deadline nears). Safe on every instance.
    run: async (ctx) => {
      const r = await sendRecordNotices(ctx);
      if (r.sent || r.failed) console.log(`record notices: sent ${r.sent}, failed ${r.failed}`);
    },
  },
];

/** The jobs that should run for this configuration. */
export const jobsFor = (ctx: Ctx, jobs: Job[] = JOBS): Job[] => jobs.filter((j) => j.module === null || ctx.config.modules[j.module]);

/** Start them: once now, then on their interval. Returns the names started. */
export function startJobs(ctx: Ctx, jobs: Job[] = JOBS): string[] {
  const chosen = jobsFor(ctx, jobs);
  for (const j of chosen) {
    const tick = () => j.run(ctx).catch((e) => console.error(`${j.name}:`, e?.message ?? e));
    void tick();
    setInterval(tick, j.everySeconds * 1000).unref();
  }
  return chosen.map((j) => j.name);
}
