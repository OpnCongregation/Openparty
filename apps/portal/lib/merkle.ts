// Browser-side verifier for the OpenParty transparency log (RFC 6962 hashing). Mirrors services/trustlog/merkle.go.
import { ed25519 } from "@noble/curves/ed25519";

const enc = new TextEncoder();
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

export const hashLeaf = (data: Uint8Array) => sha256(new Uint8Array([0]), data);
export const hashChildren = (l: Uint8Array, r: Uint8Array) => sha256(new Uint8Array([1]), l, r);

export async function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: Uint8Array[], root: Uint8Array): Promise<boolean> {
  if (index < 0 || index >= size) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      r = await hashChildren(p, r);
      if (!(fn & 1)) while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = await hashChildren(r, p);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && hex(r) === hex(root);
}

export const headMessage = (size: number, root: string) => enc.encode(`openparty-log/v1\n${size}\n${root}`);

export function verifySig(pubHex: string, sigHex: string, size: number, root: string): boolean {
  try { return ed25519.verify(unhex(sigHex), headMessage(size, root), unhex(pubHex)); } catch { return false; }
}
