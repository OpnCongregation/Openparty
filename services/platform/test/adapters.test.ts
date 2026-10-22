import { SimNgNinAdapter } from "../src/adapters.js";
import { adapterConformance } from "./adapter-conformance.js";
import { TestlandIdAdapter } from "./fixtures/tl-adapter.js";

adapterConformance("ng_nin (Nigeria, simulated)", () => new SimNgNinAdapter(), "12345678901", ["0123456789", "abc", "1234567890", "01234567890"]);
adapterConformance("tl_id (synthetic Testland)", () => new TestlandIdAdapter(), "TL123456", ["TL12", "NG123456", "123456"]);
