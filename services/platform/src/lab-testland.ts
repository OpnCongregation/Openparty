import type { IdAdapter, IdResult } from "./adapters.js";

/** Synthetic ID system of the fictional Testland (ids look like TL123456). Used only by the lab's "same core" scenario. */
export class TestlandAdapter implements IdAdapter {
  readonly id = "tl_id";
  readonly assurance = 1 as const;
  async verify(subjectId: string): Promise<IdResult | null> {
    if (!/^TL\d{6}$/.test(subjectId)) return null;
    return {
      verified: true, ageOk: true, area: "Capital Ward", assurance: this.assurance, preview: "TES…",
      attributes: { name: `Tess Tester ${subjectId.slice(-3)}`, birth_date: "1990-01-01", ward: "Capital Ward" },
    };
  }
}
