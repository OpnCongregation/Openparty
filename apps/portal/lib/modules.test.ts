import { describe, expect, it } from "vitest";
import { moduleForPath, visibleLinks, type Modules } from "./modules";

const off: Modules = { finance: false, petitions: false, ussd: false, voting: false, secret_ballot: false };
const links: [string, string][] = [["/", "Log"], ["/election", "Elections"], ["/election/guardian", "Guardians"], ["/ussd", "USSD"], ["/framework", "Framework"]];

describe("portal modules", () => {
  it("maps pages to modules, most specific first", () => {
    expect(moduleForPath("/election")).toBe("voting");
    expect(moduleForPath("/election/vote")).toBe("voting");
    expect(moduleForPath("/election/audit")).toBe("secret_ballot");
    expect(moduleForPath("/ussd")).toBe("ussd");
    expect(moduleForPath("/framework")).toBeNull();
  });
  it("hides the pages of modules that are off, and shows only core pages when unknown", () => {
    expect(visibleLinks(links, off).map((l) => l[0])).toEqual(["/", "/framework"]);
    expect(visibleLinks(links, null).map((l) => l[0])).toEqual(["/", "/framework"]);
    expect(visibleLinks(links, { ...off, voting: true }).map((l) => l[0])).toEqual(["/", "/election", "/framework"]);
    expect(visibleLinks(links, { ...off, voting: true, secret_ballot: true, ussd: true }).length).toBe(5);
  });
});
