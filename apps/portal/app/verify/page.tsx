"use client";
import { useState } from "react";
import { hashLeaf, hex, unhex, verifyInclusion, verifySig } from "../../lib/merkle";

type Head = { size: number; root: string; time: string; signature: string; logKey: string };
type Cosig = { witness: string; signature: string };
type Anchor = { size: number; root: string; anchoredAt: string; chain: string; status?: string; btcHeight?: number; proof?: string };
type Entry = { index: number; text: string; leaf?: string; included?: boolean };

const DEFAULT_LOG = process.env.NEXT_PUBLIC_TRUSTLOG_URL ?? "http://localhost:8080";

export default function Verifier() {
  const [url, setUrl] = useState(DEFAULT_LOG);
  const [trustedKey, setTrustedKey] = useState("");
  const [witnessKeys, setWitnessKeys] = useState("");
  const [head, setHead] = useState<Head | null>(null);
  const [sigOk, setSigOk] = useState<boolean | null>(null);
  const [cosigs, setCosigs] = useState<{ witness: string; ok: boolean; trusted: boolean }[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [err, setErr] = useState("");

  const base = url.replace(/\/$/, "");

  async function load() {
    setErr(""); setEntries([]);
    try {
      const r = await fetch(`${base}/head`).then((x) => x.json());
      const h: Head = r.head;
      setHead(h);
      // Only trust the key you pinned out of band. If none is pinned, the check only proves self-consistency.
      setSigOk(verifySig(h.logKey, h.signature, h.size, h.root) && (!trustedKey || trustedKey === h.logKey));
      const trusted = new Set(witnessKeys.split(/[\s,]+/).filter(Boolean));
      setCosigs((r.cosignatures as Cosig[]).map((c) => ({ witness: c.witness, ok: verifySig(c.witness, c.signature, h.size, h.root), trusted: trusted.has(c.witness) })));
      fetch(`${base}/anchors`).then((x) => x.text()).then((t) =>
        setAnchors(t.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Anchor).slice(-5).reverse())).catch(() => setAnchors([]));
      const from = Math.max(0, h.size - 20);
      const e = await fetch(`${base}/entries?from=${from}&to=${h.size}`).then((x) => x.json());
      setEntries((e.entries as string[]).map((b, i) => ({ index: from + i, text: atob(b) })).reverse());
    } catch (e: any) { setErr(String(e.message ?? e)); }
  }

  async function check(en: Entry) {
    if (!head) return;
    const p = await fetch(`${base}/proof/inclusion?index=${en.index}&size=${head.size}`).then((x) => x.json());
    // Recompute the leaf hash from the entry bytes ourselves; never trust the server's leafHash.
    const bytes = Uint8Array.from(en.text, (c) => c.charCodeAt(0));
    const leaf = await hashLeaf(bytes);
    const ok = await verifyInclusion(leaf, en.index, head.size, (p.proof as string[]).map(unhex), unhex(head.root));
    setEntries((all) => all.map((x) => (x.index === en.index ? { ...x, leaf: hex(leaf), included: ok } : x)));
  }

  const goodCosigs = cosigs.filter((c) => c.ok && c.trusted).length;

  return (
    <>
      <h1>Public log verifier</h1>
      <p className="lead">Checks the log's signature, the witness cosignatures, and that an entry really is in the log, all in your browser.</p>
      <div className="card">
        <div className="row"><input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Log URL" /><button onClick={load}>Fetch head</button></div>
        <p className="muted">Pin the log's public key and witness keys (published by the party and foundation) to make the checks meaningful.</p>
        <div className="row"><input placeholder="Pinned log public key (hex)" value={trustedKey} onChange={(e) => setTrustedKey(e.target.value.trim())} /></div>
        <div className="row" style={{ marginTop: 8 }}><input placeholder="Trusted witness keys (hex, comma separated)" value={witnessKeys} onChange={(e) => setWitnessKeys(e.target.value)} /></div>
      </div>
      {err && <p className="bad">Could not reach the log: {err}</p>}
      {head && (
        <div className="card">
          <p><strong>{head.size}</strong> entries · <span className="muted">{head.time}</span></p>
          <p>Root <code>{head.root}</code></p>
          <p>Log signature: {sigOk ? <span className="ok">valid{trustedKey ? " and from the pinned key" : " (key not pinned)"}</span> : <span className="bad">INVALID</span>}</p>
          <p>Witnesses: {cosigs.length === 0 ? <span className="bad">no valid cosignatures: do not trust this head</span> : <span className={goodCosigs ? "ok" : "muted"}>{cosigs.filter((c) => c.ok).length} valid signature(s), {goodCosigs} from trusted keys</span>}</p>
        </div>
      )}
      {head && (
        <div className="card">
          <strong>External timestamps</strong>
          {anchors.length === 0 ? <p className="muted small">None yet.</p> : (
            <table>
              <tbody>
                {anchors.map((a) => (
                  <tr key={`${a.size}-${a.chain}`}>
                    <td>{a.size} entries<div className="muted small">{a.anchoredAt}</div></td>
                    <td>
                      {a.chain === "simulated" && <span className="bad">Simulated: a local note, not an external proof</span>}
                      {a.chain === "opentimestamps" && a.status === "bitcoin" && <span className="ok">Confirmed in Bitcoin block {a.btcHeight}</span>}
                      {a.chain === "opentimestamps" && a.status !== "bitcoin" && <span className="muted">Submitted, waiting for a Bitcoin block (usually hours)</span>}
                      {a.proof && <div className="small"><a href={`${base}/anchors/${a.proof}`}>Download .ots proof</a> <span className="muted">(check with the OpenTimestamps client)</span></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {entries.length > 0 && (
        <table>
          <thead><tr><th>#</th><th>Entry</th><th /></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.index}>
                <td>{e.index}</td>
                <td><code>{e.text}</code>{e.included !== undefined && <div className={e.included ? "ok" : "bad"}>{e.included ? "Inclusion proof verified against the head" : "INCLUSION PROOF FAILED"}</div>}</td>
                <td><button className="secondary" onClick={() => check(e)}>Verify</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
