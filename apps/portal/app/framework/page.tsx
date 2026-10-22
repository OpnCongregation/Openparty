"use client";
import { useEffect, useMemo, useState } from "react";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

interface Floor { id: string; title: string; enforces: string; grounds: string; status: "enforced" | "partial" | "not_built"; gap?: string; note?: string; check_result?: { ok: boolean; detail: string } }
interface Rule {
  id: string; title: string; source: string; floor: string; status: "enforced" | "partial" | "declared" | "needs_attestation"; packStatus: string; effect: string;
  rules: string[]; partyValue: Record<string, unknown>; partyPasses: boolean | null; tightensLaw: boolean;
  enforcedBy: { param: string; by: string }[]; attestation?: { text: string; state: string };
}
interface Registry { deployments: { id: string; name: string; party: string; country: string; law_pack: { id: string; version: string; status: string }; floor_version: string; id_adapter: string; certified_by: string | null; last_check: string | null; status: string; reason?: string }[]; note?: string }
interface Data {
  notice: string; fingerprint: string;
  layers: { floor: { version: string; hash: string }; pack: { id: string; name: string; version: string; status: string; hash: string; signature: string; currency: { code: string } }; party: { name: string; hash: string } };
  summary: { packRules: number; enforced: number; partial: number; declared: number; needsAttestation: number; floor: { enforced: number; partial: number; notBuilt: number } };
  floor: Floor[]; rules: Rule[]; floorBreached: string[]; violations: { rule: string; message: string }[];
  party: { name: string; settings: Record<string, unknown>; profile: Record<string, any> };
  featuresOff: { key: string; effect: string; source: string }[];
  registry: Registry;
}
interface Check { param: string; value: unknown; known: boolean; accepted: boolean; violations: { rule: string; message: string; source: string }[]; packDefault: unknown; currentValue: unknown }

const LABEL: Record<string, string> = {
  enforced: "Enforced by code", partial: "Partly enforced", declared: "Declared, module not built", needs_attestation: "Needs human review", not_built: "Not built",
};
const cls = (s: string) => (s === "enforced" ? "ok" : s === "partial" ? "warn" : s === "needs_attestation" ? "warn" : "muted");
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export default function Framework() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("all");
  const [param, setParam] = useState("finance.cap_per_donor_minor");
  const [value, setValue] = useState("60000000000");
  const [check, setCheck] = useState<Check | null>(null);

  useEffect(() => {
    fetch(`${PLATFORM}/framework`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setD)
      .catch((e) => setErr(String(e.message).includes("fetch") ? `Platform unreachable at ${PLATFORM}` : e.message));
  }, []);

  async function run(p = param, v = value) {
    setParam(p); setValue(v);
    try {
      const r = await fetch(`${PLATFORM}/framework/check?param=${encodeURIComponent(p)}&value=${encodeURIComponent(v)}`);
      setCheck(await r.json());
    } catch (e: any) { setErr(`Could not check: ${e.message}`); }
  }

  const rules = useMemo(() => (d?.rules ?? []).filter((r) =>
    (only === "all" || r.status === only) && (!q || `${r.id} ${r.title} ${r.source} ${r.floor}`.toLowerCase().includes(q.toLowerCase()))), [d, q, only]);

  if (err) return <><h1>Framework</h1><p className="bad" role="alert">{err}</p></>;
  if (!d) return <><h1>Framework</h1><p className="muted">Loading…</p></>;

  const s = d.summary;
  const p = d.party.profile;
  const ex = [
    ["Looser than the law (refused)", "notice.days_before_contest", "10"],
    ["Stricter than the law (accepted)", "notice.days_before_contest", "30"],
    ["Donor cap above the legal N500m", "finance.cap_per_donor_minor", "60000000000"],
    ["Allow anonymous gifts", "finance.anonymous_gifts_allowed", "true"],
    ["Let the party add its own criteria", "eligibility.party_criteria_allowed", "true"],
  ];

  return (
    <>
      <h1>Framework</h1>
      <p className="lead">One universal core, a country law pack, and a party's own settings, all sitting on an international floor. A higher layer can only tighten a lower one.</p>
      <p className="small muted">{d.notice}</p>

      <div className="layers" aria-label="The layers">
        <div className="layer l3"><span className="muted small">Party settings · changes freely, checked against the pack</span><strong>{d.layers.party.name}</strong><span className="small">{p.name} ({p.acronym})</span></div>
        <div className="layer l2"><span className="muted small">Country law pack · local counsel, signed by the foundation</span><strong>{d.layers.pack.name} v{d.layers.pack.version}</strong>
          <span className="small">{d.layers.pack.status} · {d.layers.pack.signature} · {s.packRules} rules</span></div>
        <div className="layer l1"><span className="muted small">Universal core · never changes by country</span><strong>Secret ballot, one member one vote, encrypted ledger, witnesses, separation of powers</strong></div>
        <div className="layer l0"><span className="muted small">International floor · rarely changes, board supermajority</span><strong>Floor v{d.layers.floor.version}: F1 to F12</strong></div>
      </div>
      <p className="small">Configuration fingerprint <code>{d.fingerprint}</code></p>

      <h2>International floor</h2>
      <p className="small muted">{s.floor.enforced} enforced · {s.floor.partial} partly · {s.floor.notBuilt} not built yet. Status is this codebase's own account of itself.</p>
      <table>
        <thead><tr><th>#</th><th>Rule</th><th>Grounded in</th><th>Status</th></tr></thead>
        <tbody>
          {d.floor.map((f) => (
            <tr key={f.id}>
              <td><strong>{f.id}</strong></td>
              <td>{f.title}<div className="muted small">{f.enforces}</div>{f.gap && <div className="small">Gap: {f.gap}</div>}{f.note && <div className="muted small">{f.note}</div>}
                {f.check_result && <div className={`small ${f.check_result.ok ? "ok" : "bad"}`}>Automated check: {f.check_result.ok ? "passes" : "FAILS"}. {f.check_result.detail}</div>}</td>
              <td className="small">{f.grounds}</td>
              <td><span className={cls(f.status)}>{LABEL[f.status]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{d.layers.pack.name} law pack</h2>
      <p className="small muted">
        {s.enforced} rules enforced by code · {s.partial} partly · {s.declared} declared but waiting for a module that is not built · {s.needsAttestation} need a human review.
        This pack is a <strong>{d.layers.pack.status}</strong> transcribed from the product requirements document and has not been reviewed by counsel. It is not legal advice.
      </p>
      <div className="row" style={{ margin: "8px 0" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules, e.g. NG-FIN, register, s.85" aria-label="Search rules" />
        <select value={only} onChange={(e) => setOnly(e.target.value)} aria-label="Filter by status">
          <option value="all">All</option><option value="enforced">Enforced</option><option value="partial">Partly</option><option value="declared">Declared</option><option value="needs_attestation">Needs review</option>
        </select>
      </div>
      {d.featuresOff.length > 0 && (
        <div className="card"><strong>Switched off by law</strong>
          {d.featuresOff.map((f) => <div key={f.key} className="small"><code>{f.key}</code>: {f.effect} <span className="muted">({f.source})</span></div>)}
        </div>)}
      <div>
        {rules.map((r) => (
          <details key={r.id} className="rule">
            <summary>
              <strong>{r.id}</strong> {r.title}
              <span className={`chip ${cls(r.status)}`}>{LABEL[r.status]}</span>
              {r.partyPasses === false && <span className="chip bad">party breaks it</span>}
              {r.tightensLaw && <span className="chip ok">party is stricter</span>}
            </summary>
            <div className="small">
              <div><strong>Source</strong> {r.source} · floor {r.floor} · {r.packStatus}</div>
              <div><strong>Effect</strong> {r.effect}</div>
              {r.rules.length > 0 && <div><strong>Rule</strong> {r.rules.map((x) => <code key={x} style={{ marginRight: 8 }}>{x}</code>)}</div>}
              {Object.keys(r.partyValue).length > 0 && r.rules.length > 0 && <div><strong>Party value</strong> {Object.entries(r.partyValue).map(([k, v]) => <code key={k} style={{ marginRight: 8 }}>{k} = {show(v)}</code>)}</div>}
              {r.enforcedBy.length > 0 && <div><strong>Enforced in</strong> {r.enforcedBy.map((e) => <span key={e.param} style={{ marginRight: 8 }}>{e.by}</span>)}</div>}
              {r.attestation && <div><strong>Review</strong> {r.attestation.text} <em>({r.attestation.state})</em></div>}
            </div>
          </details>
        ))}
        {rules.length === 0 && <p className="muted small">No rules match.</p>}
      </div>

      <h2>Try a party setting</h2>
      <p className="small muted">See whether the law pack would accept a setting, and which rule decides. Nothing is saved.</p>
      <div className="row">
        <input value={param} onChange={(e) => setParam(e.target.value)} aria-label="Setting name" />
        <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value (JSON)" style={{ maxWidth: 220 }} />
        <button onClick={() => run()}>Check</button>
      </div>
      <div className="row" style={{ margin: "8px 0" }}>
        {ex.map(([label, p2, v2]) => <button key={label} className="secondary" onClick={() => run(p2, v2)}>{label}</button>)}
      </div>
      {check && (
        <div className={`card ${check.accepted ? "okcard" : "badcard"}`} aria-live="polite">
          <strong className={check.accepted ? "ok" : "bad"}>{check.accepted ? "Accepted" : "Refused"}</strong>{" "}
          <code>{check.param} = {show(check.value)}</code>
          {!check.known && <div className="small">That is not a setting this framework knows.</div>}
          {check.violations.map((v) => <div key={v.rule} className="small"><strong>{v.rule}</strong> {v.message}{v.source && <span className="muted"> ({v.source})</span>}</div>)}
          {check.accepted && <div className="small muted">Pack default {show(check.packDefault)} · current {show(check.currentValue)}</div>}
        </div>
      )}

      <h2>{p.acronym}: reference party settings</h2>
      <div className="card">
        <p style={{ margin: 0 }}><strong>{p.name}</strong> · {p.headquarters} · motto <em>{p.motto}</em> · logo: {p.logo}</p>
        <p className="small muted">A potential party, not registered with INEC. Values marked sample are examples, not decisions.</p>
        <table>
          <thead><tr><th>Setting</th><th>Value</th></tr></thead>
          <tbody>{Object.entries(d.party.settings).map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{show(v)}</td></tr>)}</tbody>
        </table>
        <details><summary>Creed</summary><ol className="small">{(p.creed ?? []).map((c: string) => <li key={c}>{c}</li>)}</ol></details>
        <details><summary>Organs and national officers</summary>
          <table className="small"><tbody>{(p.organs ?? []).map((o: any) => <tr key={o.name}><td><strong>{o.name}</strong></td><td>{o.sits}</td><td>{o.role}</td></tr>)}</tbody></table>
          <ul className="small">{(p.national_officers ?? []).map((o: any) => <li key={o.office}>{o.office}: {o.count}</li>)}</ul>
        </details>
      </div>

      <h2>Public registry of deployments</h2>
      <p className="small muted">{d.registry.note}</p>
      <table>
        <thead><tr><th>Deployment</th><th>Law pack</th><th>Floor</th><th>ID adapter</th><th>Certified by</th><th>Status</th></tr></thead>
        <tbody>{d.registry.deployments.map((x) => (
          <tr key={x.id}><td>{x.party}<div className="muted small">{x.reason}</div></td><td>{x.law_pack.id} v{x.law_pack.version} ({x.law_pack.status})</td><td>v{x.floor_version}</td>
            <td>{x.id_adapter}</td><td>{x.certified_by ?? "Not yet"}</td><td><span className="chip muted">{x.status}</span></td></tr>))}</tbody>
      </table>
    </>
  );
}
