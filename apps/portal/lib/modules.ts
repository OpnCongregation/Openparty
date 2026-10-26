// Which optional platform modules a portal page needs. The platform's /public/modules says which are on (parties/<party>/settings.yaml).
export type ModuleName = "finance" | "petitions" | "ussd" | "voting" | "secret_ballot";
export type Modules = Record<ModuleName, boolean>;

export const MODULE_LABEL: Record<ModuleName, string> = {
  finance: "Finance", petitions: "Petitions", ussd: "USSD", voting: "Voting", secret_ballot: "Secret ballot",
};

/** Most specific first. A path that matches nothing here is a core page. */
const PAGE_MODULES: [string, ModuleName][] = [
  ["/election/guardian", "secret_ballot"],
  ["/election/audit", "secret_ballot"],
  ["/election", "voting"],
  ["/ussd", "ussd"],
];

export function moduleForPath(path: string): ModuleName | null {
  for (const [prefix, m] of PAGE_MODULES) if (path === prefix || path.startsWith(prefix + "/")) return m;
  return null;
}

/** Keep the links the deployment has switched on. `null` (not loaded yet, or the platform is unreachable) keeps only the core pages. */
export function visibleLinks<T extends readonly [string, ...string[]]>(links: T[], modules: Modules | null): T[] {
  return links.filter(([href]) => {
    const m = moduleForPath(href);
    return m === null || modules?.[m] === true;
  });
}
