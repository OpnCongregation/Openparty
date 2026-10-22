"use client";
import { useEffect, useMemo, useState } from "react";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

interface Test { name: string; status: "passed" | "failed" | "skipped"; ms: number; error?: string }
interface Group { name: string; tests: Test[] }
interface Suite { id: string; name: string; tool: string; passed: number; failed: number; skipped: number; durationMs: number; groups: Group[] }
interface Report { generatedAt: string; durationMs: number; totals: { passed: number; failed: number; skipped: number }; suites: Suite[] }

const ICON = { passed: "✓", failed: "✗", skipped: "–" } as const;
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function age(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export default function Tests() {
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  async function load() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${PLATFORM}/lab/report`, { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message ?? (r.status === 404 ? "The lab is switched off on this platform (LAB_ENABLED=1)." : `HTTP ${r.status}`));
      setReport(body);
    } catch (e: any) {
      setErr(String(e.message).includes("fetch") ? `Platform unreachable at ${PLATFORM}` : e.message);
    }
    setBusy(false);
  }
  useEffect(() => { load(); }, []);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!report) return [];
    return report.suites.map((s) => ({
      ...s,
      groups: s.groups
        .map((g) => ({ ...g, tests: g.tests.filter((t) => (!failedOnly || t.status === "failed") && (!needle || `${g.name} ${t.name}`.toLowerCase().includes(needle))) }))
        .filter((g) => g.tests.length),
    }));
  }, [report, needle, failedOnly]);

  const cmd = "npm run report";
  const stale = report ? Date.now() - new Date(report.generatedAt).getTime() > 24 * 3600 * 1000 : false;
  const allGood = report ? report.totals.failed === 0 : false;

  return (
    <>
      <h1>Test results</h1>
      <p className="lead">
        Every automated test in the project, grouped by what it protects. This shows the results of the <strong>last run on this computer</strong>; it
        does not run tests itself.
      </p>

      {err && (
        <div className="card">
          <p className="bad" role="alert">{err}</p>
          <p className="small">Create a report by running this in the <code>openparty</code> folder, then refresh:</p>
          <code>{cmd}</code>
        </div>
      )}

      {report && (
        <>
          <div className={`card sumbar ${allGood ? "good" : "badbar"}`}>
            <div>
              <strong style={{ fontSize: "1.3rem" }} className={allGood ? "ok" : "bad"}>
                {allGood ? "All tests pass" : `${report.totals.failed} failing`}
              </strong>
              <div className="muted small">
                {report.totals.passed} passed · {report.totals.failed} failed · {report.totals.skipped} skipped · took {secs(report.durationMs)}
              </div>
            </div>
            <div className="small">
              <div>Last run {age(report.generatedAt)}</div>
              <div className="muted">{new Date(report.generatedAt).toLocaleString()}</div>
            </div>
            <div className="row">
              <button className="secondary" onClick={load} disabled={busy}>{busy ? "Loading…" : "Reload results"}</button>
            </div>
          </div>
          {stale && <p className="bad small">These results are more than a day old. Re-run the tests to refresh them.</p>}

          <div className="row" style={{ margin: "8px 0" }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tests, e.g. cap, notice, ussd" aria-label="Search tests" />
            <label className="small" style={{ whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} style={{ width: "auto", marginRight: 6 }} />
              Failed only
            </label>
          </div>

          {shown.map((s) => {
            const key = s.id;
            const forced = !!needle || failedOnly || s.failed > 0;
            const isOpen = open[key] ?? forced;
            return (
              <section key={s.id} className="card" aria-label={s.name}>
                <button className="stepbtn suitebtn" onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))} aria-expanded={isOpen}>
                  <span className="ico">{isOpen ? "▾" : "▸"}</span>
                  <span className="body">
                    <span className="t">{s.name}</span>
                    <span className="muted small">{s.tool} · {secs(s.durationMs)}</span>
                  </span>
                  <span className={s.failed ? "bad" : "ok"}>{s.passed} passed{s.failed ? `, ${s.failed} failed` : ""}{s.skipped ? `, ${s.skipped} skipped` : ""}</span>
                </button>
                {isOpen && s.groups.map((g) => (
                  <div key={g.name} className="tgroup">
                    <div className="tgname">{g.name} <span className="muted small">({g.tests.length})</span></div>
                    <ul className="tlist">
                      {g.tests.map((t) => (
                        <li key={t.name} className={`trow ${t.status}`}>
                          <span className="ico" title={t.status}>{ICON[t.status]}</span>
                          <span className="tn">{t.name}</span>
                          <span className="muted small">{secs(t.ms)}</span>
                          {t.error && <pre className="terr">{t.error}</pre>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {isOpen && s.groups.length === 0 && <p className="muted small">No tests match.</p>}
              </section>
            );
          })}

          <div className="card">
            <strong>Refresh these results</strong>
            <p className="small muted" style={{ margin: "4px 0 8px" }}>
              Run in the <code>openparty</code> folder. It runs all four suites (about a minute), then press <em>Reload results</em>.
            </p>
            <div className="row">
              <code>{cmd}</code>
              <button className="secondary" onClick={() => { navigator.clipboard?.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
