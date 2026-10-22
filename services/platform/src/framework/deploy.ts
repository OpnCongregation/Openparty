import type { Ctx } from "../context.js";

/**
 * Record which configuration this deployment is running. When the fingerprint of (floor + law pack + party settings)
 * differs from the last one recorded, store it and post it to the public log, so anyone can see when the rules a
 * deployment runs under changed (PRD sections 11 and 18). Only identifiers and the fingerprint go on the log.
 */
export async function recordDeployment(ctx: Ctx): Promise<{ changed: boolean; fingerprint: string }> {
  const c = ctx.config;
  const last = await ctx.db.query<{ fingerprint: string }>("SELECT fingerprint FROM deployment_config ORDER BY id DESC LIMIT 1");
  if (last.length && last[0].fingerprint === c.fingerprint) return { changed: false, fingerprint: c.fingerprint };
  await ctx.commit(async (tx) => {
    await tx.query(
      "INSERT INTO deployment_config(fingerprint,floor_version,pack_id,pack_version,party) VALUES ($1,$2,$3,$4,$5)",
      [c.fingerprint, c.floor.version, c.pack.id, c.pack.version, c.party.party]);
    await ctx.events.emit(tx, {
      type: "deployment.configured",
      data: { fingerprint: c.fingerprint, floor_version: c.floor.version, pack_id: c.pack.id, pack_version: c.pack.version, pack_status: c.pack.status, pack_signature: c.pack.signature },
    });
  });
  return { changed: true, fingerprint: c.fingerprint };
}
