import { describe, expect, it } from "vitest";
import type { IdAdapter } from "../src/adapters.js";

/**
 * Public conformance suite for ID adapters (PRD section 16). Any adapter used in a certified deployment must pass it.
 * What the core may learn: verified, age check, area, assurance. Never the id number outside the encrypted register.
 */
export function adapterConformance(name: string, make: () => IdAdapter, validId: string, invalidIds: string[]) {
  describe(`ID adapter conformance: ${name}`, () => {
    const a = make();
    it("declares a stable id and an assurance level of 1, 2 or 3", () => {
      expect(a.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect([1, 2, 3]).toContain(a.assurance);
    });
    it("rejects ids that are not valid", async () => {
      for (const bad of invalidIds) expect(await a.verify(bad)).toBeNull();
      expect(await a.verify("")).toBeNull();
    });
    it("verifies a valid id and returns the contract fields", async () => {
      const r = await a.verify(validId);
      expect(r).not.toBeNull();
      expect(r!.verified).toBe(true);
      expect(typeof r!.ageOk).toBe("boolean");
      expect([1, 2, 3]).toContain(r!.assurance);
      expect(r!.assurance).toBeLessThanOrEqual(a.assurance);
      expect(typeof r!.preview).toBe("string");
    });
    it("never leaks the id number outside the register attributes", async () => {
      const r = (await a.verify(validId))!;
      const { attributes, ...rest } = r;
      expect(JSON.stringify(rest)).not.toContain(validId);
      expect(Object.keys(attributes)).not.toContain("national_id");
      for (const v of Object.values(attributes)) expect(v).not.toContain(validId);
    });
    it("is deterministic: the same person gives the same answer", async () => {
      expect(await a.verify(validId)).toEqual(await a.verify(validId));
    });
    it("shows a preview from which the id cannot be derived", async () => {
      const r = (await a.verify(validId))!;
      expect(r.preview).not.toContain(validId);
    });
  });
}
