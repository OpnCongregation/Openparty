/**
 * Optional modules. A party switches them on or off in the `modules:` section of its settings.yaml.
 * Membership, the trust log, approvals and the law pack checks are core: they are not listed here and cannot be turned off.
 */
export const MODULE_NAMES = ["finance", "petitions", "ussd", "voting", "secret_ballot"] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];
export type Modules = Record<ModuleName, boolean>;

/** Parts of the platform that are always on. Naming them in `modules:` is an error, so nobody thinks they can switch them off. */
export const CORE_PARTS = ["membership", "trust_log", "approvals", "law_pack_checks"] as const;

/** module -> the modules it cannot run without. */
export const REQUIRES: Partial<Record<ModuleName, ModuleName[]>> = { secret_ballot: ["voting"] };

export class ModulesError extends Error {
  constructor(readonly problems: string[]) {
    super(`modules section of the party settings is not valid:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
}

/**
 * Read the `modules:` section. A module that is not listed is OFF (turning something on is always a written decision),
 * and a missing section turns every optional module off. Anything unclear is refused rather than guessed.
 */
export function resolveModules(raw: unknown): Modules {
  const out = Object.fromEntries(MODULE_NAMES.map((m) => [m, false])) as Modules;
  const problems: string[] = [];
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) problems.push("`modules` must be a list of name: true/false lines");
    else for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if ((CORE_PARTS as readonly string[]).includes(k)) problems.push(`${k} is core and cannot be turned on or off`);
      else if (!(MODULE_NAMES as readonly string[]).includes(k)) problems.push(`unknown module "${k}" (known: ${MODULE_NAMES.join(", ")})`);
      else if (typeof v !== "boolean") problems.push(`${k} must be true or false, not ${JSON.stringify(v)}`);
      else out[k as ModuleName] = v;
    }
  }
  if (!problems.length) for (const [m, needs] of Object.entries(REQUIRES) as [ModuleName, ModuleName[]][])
    if (out[m]) for (const n of needs) if (!out[n]) problems.push(`${m} needs ${n} to be on as well`);
  if (problems.length) throw new ModulesError(problems);
  return out;
}
