import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { hashChildren, hashLeaf, headMessage, hex, unhex, verifyInclusion, verifySig } from "./merkle";

const enc = new TextEncoder();

// Vectors produced by the Go trustlog service (entries sent with curl -d).
const LEAF = [
  "5ca35b6b56795a8d1acf6da7474b594e7702d1acfcb7180700b2241b7da0dd4a",
  "d84b677e3db80056b29ca3a8127bdd4876ab4cf975bab99a4c864d8b5af440e3",
  "0b2007384527ba4e40e26af4024c3667b7fd919e298fe6de5f0dd6be674c4a9e",
];
const GO_ROOT = "cb1ae5b228277ca5f8dbea48a9784220b7619b6c7d9e5669c25f14a77078f4a5";

describe("verifier matches the Go log", () => {
  it("hashes a leaf the same way", async () => {
    expect(hex(await hashLeaf(enc.encode('{"type":"test","n":1}')))).toBe(LEAF[0]);
  });
  it("verifies Go's 3-entry root with RFC 6962 audit paths", async () => {
    const [l0, l1, l2] = LEAF.map(unhex);
    const left = await hashChildren(l0, l1);
    expect(hex(await hashChildren(left, l2))).toBe(GO_ROOT);
    const root = unhex(GO_ROOT);
    expect(await verifyInclusion(l2, 2, 3, [left], root)).toBe(true);
    expect(await verifyInclusion(l0, 0, 3, [l1, l2], root)).toBe(true);
    expect(await verifyInclusion(l1, 1, 3, [l0, l2], root)).toBe(true);
    // wrong index, wrong leaf, truncated proof all fail
    expect(await verifyInclusion(l1, 0, 3, [l0, l2], root)).toBe(false);
    expect(await verifyInclusion(unhex(LEAF[0]), 2, 3, [left], root)).toBe(false);
    expect(await verifyInclusion(l0, 0, 3, [l1], root)).toBe(false);
  });
  it("checks head signatures and rejects forgeries", () => {
    const priv = ed25519.utils.randomPrivateKey();
    const pub = hex(ed25519.getPublicKey(priv));
    const sig = hex(ed25519.sign(headMessage(3, GO_ROOT), priv));
    expect(verifySig(pub, sig, 3, GO_ROOT)).toBe(true);
    expect(verifySig(pub, sig, 4, GO_ROOT)).toBe(false);
    expect(verifySig(pub, "00".repeat(64), 3, GO_ROOT)).toBe(false);
  });
});
