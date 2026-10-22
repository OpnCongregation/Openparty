"use client";
import { useEffect, useState } from "react";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

interface Meta { id: string; title: string; law: string; blurb: string }
interface StepState { members: Record<string, number>; contests: { name: string; state: string }[]; ledgerNaira: number; logSize: number }
interface Step {
  n: number; kind: "allowed" | "blocked" | "time" | "fail"; title: string; law?: string; detail: string; code?: string;
  day: number; logAdded: { type: string; data: unknown }[]; state: StepState;
}
interface Result extends Meta { steps: Step[]; passed: boolean; counts: { allowed: number; blocked: number; fail: number }; ms: number }

const ICON = { allowed: "✓", blocked: "⛔", time: "⏱", fail: "✗" } as const;
const LABEL = { allowed: "Allowed", blocked: "Refused, as the law requires", time: "Time passes", fail: "Unexpected" } as const;

export default function Lab() {
  const [list, setList] = useState<Meta[]>([]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`${PLATFORM}/lab/scenarios`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "The lab is switched off on this platform. Set LAB_ENABLED=1 and restart it." : `HTTP ${r.status}`))))
      .then(setList)
      .catch((e) => setErr(e.message.includes("fetch") ? `Platform unreachable at ${PLATFORM}` : e.message));
  }, []);

  async function run(id: string) {
    setRunning(id); setErr("");
    try {
      const r = await fetch(`${PLATFORM}/lab/run/${id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res: Result = await r.json();
      setResults((p) => ({ ...p, [id]: res }));
      setShown(id); setSel(null);
    } catch (e: any) { setErr(`Could not run ${id}: ${e.message}`); }
    setRunning(null);
  }
  async function runAll() { for (const s of list) await run(s.id); }

  const total = Object.values(results);
  const cur = shown ? results[shown] : null;
  const at = cur ? cur.steps[sel ?? cur.steps.length - 1] : null;

  return (
    <>
      <h1>Rules lab</h1>
      <p className="lead">
        Run the core rules as scenarios and watch what the system allows and refuses. Each run uses a throwaway sandbox with a virtual clock,
        so it never touches the real database or the public log.
      </p>

      <div className="row" style={{ marginBottom: 8 }}>
        <button onClick={runAll} disabled={!!running || !list.length}>{running ? "Running…" : "Run all scenarios"}</button>
        {total.length > 0 && (
          <span className={total.every((t) => t.passed) ? "ok" : "bad"}>
            {total.filter((t) => t.passed).length} of {total.length} run scenarios behave as the law requires
          </span>
        )}
      </div>
      {err && <p className="bad" role="alert">{err}</p>}

      <div className="labgrid">
        {list.map((s) => {
          const r = results[s.id];
          return (
            <div key={s.id} className={`card scen${shown === s.id ? " on" : ""}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{s.title}</strong>
                {r && <span className={r.passed ? "ok" : "bad"}>{r.passed ? "✓ pass" : "✗ fail"}</span>}
              </div>
              <div className="muted small">{s.law}</div>
              <p className="small">{s.blurb}</p>
              <div className="row">
                <button className="secondary" onClick={() => run(s.id)} disabled={!!running}>{running === s.id ? "Running…" : r ? "Run again" : "Run"}</button>
                {r && shown !== s.id && <button className="secondary" onClick={() => { setShown(s.id); setSel(null); }}>View</button>}
                {r && <span className="muted small">{r.steps.length} steps · {r.ms} ms</span>}
              </div>
            </div>
          );
        })}
      </div>

      {cur && at && (
        <section aria-label="Scenario result">
          <h2 style={{ marginBottom: 2 }}>{cur.title}</h2>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {cur.counts.allowed} allowed · {cur.counts.blocked} refused as required · {cur.counts.fail} unexpected
          </div>

          <div className="sysbar" aria-live="polite">
            <div><span className="muted small">Virtual date</span><br /><strong>Day {at.day}</strong></div>
            <div><span className="muted small">Members</span><br /><strong>{Object.entries(at.state.members).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}</strong></div>
            <div><span className="muted small">Contests</span><br /><strong>{at.state.contests.map((c) => `${c.name}: ${c.state}`).join(", ") || "none"}</strong></div>
            <div><span className="muted small">Ledger</span><br /><strong>₦{at.state.ledgerNaira.toLocaleString()}</strong></div>
            <div><span className="muted small">Public log</span><br /><strong>{at.state.logSize} entries</strong></div>
          </div>
          <p className="muted small">Click a step to see the system as it stood after it, and what it wrote to the public log.</p>

          <ol className="steps">
            {cur.steps.map((s, i) => {
              const on = (sel ?? cur.steps.length - 1) === i;
              return (
                <li key={s.n} className={`step ${s.kind}${on ? " sel" : ""}`}>
                  <button className="stepbtn" onClick={() => setSel(i)} aria-pressed={on}>
                    <span className="ico" title={LABEL[s.kind]}>{ICON[s.kind]}</span>
                    <span className="body">
                      <span className="t">{s.title}</span>
                      {s.law && <span className="chip">{s.law}</span>}
                      <span className="d">{s.detail}</span>
                    </span>
                    <span className="chip day">Day {s.day}</span>
                  </button>
                  {on && (
                    <div className="log">
                      <div className="muted small">{LABEL[s.kind]}{s.code ? ` · code ${s.code}` : ""}</div>
                      {s.logAdded.length === 0
                        ? <div className="muted small">Nothing written to the public log by this step.</div>
                        : s.logAdded.map((e, j) => (
                            <div key={j} className="ev"><code><strong>{e.type}</strong> {JSON.stringify(e.data)}</code></div>
                          ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </>
  );
}
