import { describe, expect, it } from "vitest";
import { MemoryTrustLog } from "../src/adapters.js";
import { assertLoggable, loggableTypes } from "../src/logschema.js";

const UUID = "3f2b8c1e-5a4d-4e6f-9b1a-0c2d3e4f5a6b";
const HASH = "a".repeat(64);
const REF = "b".repeat(24);

const good = {
  type: "member.activated",
  data: { member_ref: REF, agent_id: UUID, ward: "Gwale" },
};

const bad = (type: string, data: unknown) => () => assertLoggable({ type, data });

describe("public log allowlist", () => {
  it("accepts a well-formed event of every listed type shape", () => {
    expect(() => assertLoggable(good)).not.toThrow();
    expect(() => assertLoggable({ type: "finance.dues", data: { ledger_id: 7, amount_minor: 20000, member_ref: REF } })).not.toThrow();
    expect(() => assertLoggable({ type: "admin.access", data: { admin_id: UUID, action: "GET /admin/members", detail_hash: HASH } })).not.toThrow();
    expect(loggableTypes.length).toBeGreaterThan(20);
  });

  it("refuses serialized personal data hidden inside a permitted-looking field", () => {
    expect(bad("member.activated", { ...good.data, ward: '{"nin":"12345678901"}' })).toThrow();
    expect(bad("member.activated", { ...good.data, ward: "Gwale 12345678901" })).toThrow();
    expect(bad("member.activated", { ...good.data, ward: "0803 123 4567" })).toThrow();
    expect(bad("rule.set", { key: '{"name":"Musa"}', version: 1, value_hash: HASH, set_by: UUID })).toThrow();
    expect(bad("admin.access", { admin_id: UUID, action: "GET /admin/members/12345678901", detail_hash: HASH })).toThrow();
  });

  it("refuses fields that are not listed, whatever they are called", () => {
    for (const k of ["details", "note", "surname", "msisdn", "mobile", "tel", "bvn", "voter_id", "dob", "extra", "__proto__x"])
      expect(bad("member.joined", { member_ref: REF, [k]: "x" }), k).toThrow(/not allowed/);
  });

  it("refuses nested objects, arrays and wrong types in place of a scalar", () => {
    expect(bad("member.joined", { member_ref: { nested: { nin: "1" } } })).toThrow();
    expect(bad("member.joined", { member_ref: [REF] })).toThrow();
    expect(bad("finance.gift", { ledger_id: "7", amount_minor: 1 })).toThrow();
    expect(bad("finance.gift", { ledger_id: 7.5, amount_minor: 1 })).toThrow();
    expect(bad("finance.gift", { ledger_id: 7, amount_minor: -1 })).toThrow();
    expect(bad("finance.gift", { ledger_id: 7, amount_minor: null })).toThrow();
  });

  it("refuses unknown event types, missing fields and non-object data", () => {
    expect(bad("member.exported", {})).toThrow(/allowlist/);
    expect(bad("constructor", {})).toThrow(/allowlist/);
    expect(bad("toString", {})).toThrow(/allowlist/);
    expect(bad("member.joined", {})).toThrow(/missing/);
    expect(bad("member.joined", null)).toThrow();
    expect(bad("member.joined", [REF])).toThrow();
    expect(bad("member.joined", REF)).toThrow();
  });

  it("refuses a member ref that is not the pseudonymous shape (e.g. a raw phone or id)", () => {
    expect(bad("member.joined", { member_ref: "08031234567" })).toThrow();
    expect(bad("member.joined", { member_ref: "12345678901" })).toThrow();
    expect(bad("member.joined", { member_ref: UUID })).toThrow();
  });

  it("does not echo the offending value in the error", () => {
    try {
      assertLoggable({ type: "member.activated", data: { ...good.data, ward: "Gwale 12345678901" } });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).not.toContain("12345678901");
    }
  });

  it("both log implementations enforce it", async () => {
    const log = new MemoryTrustLog();
    await expect(log.append({ type: "member.joined", data: { member_ref: REF, details: '{"nin":"1"}' } })).rejects.toThrow();
    await expect(log.append({ type: "member.joined", data: { member_ref: REF } })).resolves.toMatchObject({ index: 0 });
    expect(log.events).toHaveLength(1);
  });
});
