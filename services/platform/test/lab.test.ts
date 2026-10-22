import { describe, expect, it } from "vitest";
import { SCENARIOS, runScenario } from "../src/lab.js";

describe("Lab scenarios", () => {
  for (const s of SCENARIOS)
    it(`${s.id} passes every step`, async () => {
      const r = await runScenario(s.id);
      const bad = r!.steps.filter((x) => x.kind === "fail").map((x) => `${x.n}. ${x.title}: ${x.detail}`);
      expect(bad).toEqual([]);
      expect(r!.steps.length).toBeGreaterThan(2);
    }, 30_000);
});
