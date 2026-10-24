"use client";
import { useCallback, useEffect, useState } from "react";
import { PLATFORM, call, defaultContest, errorText, store, useContests, useDemoKit, when, type Identity } from "../lib";

interface Rec {
  secretBallot: boolean; sealed: boolean; n: number; quorum: number; manifestHash: string | null; jointPublicKey: string | null;
  guardians: { position: number; keyPosted: boolean; verified: boolean | null }[];
  ballots: { submitted: number; superseded: number; counted: number };
  tallies: { set: string; ballots: number; shares: number; opened: boolean; guardiansPresent: string[] | null }[];
}
interface Audit {
  units: { unit: string; paperBallots: number | null; electronicBallots: number; status: string }[];
  choices: { raceId: string; candidacyId: string; paper: number; electronic: number; match: boolean }[] | null;
  discrepancies: number; complete: boolean;
}
interface Race { id: string; office: string; scope: string; candidates: { id: string; name: string }[] }

const STATUS: Record<string, string> = { match: "Matches", mismatch: "DOES NOT MATCH", paper_missing: "Paper not reported yet" };

export default function AuditPage() {
  const { rows } = useContests();
  const [kit, , kitReady] = useDemoKit();
  const [contestId, setContestId] = useState("");
  const [rec, setRec] = useState<Rec | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [auditMsg, setAuditMsg] = useState("");
  const [races, setRaces] = useState<Race[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; problems: string[]; ballots: number } | string | null>(null);
  const [agent, setAgent] = useState<Identity | null>(null);
  const [unit, setUnit] = useState("");
  const [paperBallots, setPaperBallots] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setAgent(store.get<Identity | null>("op_unit_agent", null)); }, []);
  useEffect(() => { if (!agent && kit) { const a = kit.admins.find((x) => x.role === "ward_agent"); if (a) setAgent(a); } }, [kit, agent]);
  useEffect(() => {
    if (contestId || !kitReady || !rows) return;
    setContestId(kit?.contestId && rows.some((c) => c.id === kit.contestId) ? kit.contestId : defaultContest(rows));
  }, [rows, kit, kitReady, contestId]);

  const contest = rows?.find((c) => c.id === contestId);
  const load = useCallback(async () => {
    if (!contestId) return;
    setVerify(null);
    const [r, e, a] = await Promise.all([call("GET", `/public/election/${contestId}/record`), call("GET", `/public/election/${contestId}`), call("GET", `/public/election/${contestId}/audit`)]);
    setRec(r.ok ? r.data : null);
    setRaces(e.ok ? e.data.races.filter((x: Race) => x.candidates.length) : []);
    if (a.ok) { setAudit(a.data); setAuditMsg(""); } else { setAudit(null); setAuditMsg(errorText(a)); }
  }, [contestId]);
  useEffect(() => { void load(); }, [load]);

  const check = async () => {
    setBusy(true); setVerify(null);
    const r = await call("GET", `/public/election/${contestId}/verify`);
    setVerify(r.ok ? r.data : errorText(r));
    setBusy(false);
  };

  const submitPaper = async () => {
    if (!agent) return;
    const list: { raceId: string; candidacyId: string | null; n: number }[] = [];
    for (const r of races) {
      for (const c of r.candidates) list.push({ raceId: r.id, candidacyId: c.id, n: Number(counts[`${r.id}:${c.id}`] || 0) });
      list.push({ raceId: r.id, candidacyId: null, n: Number(counts[`${r.id}:abstain`] || 0) });
    }
    setBusy(true);
    const r = await call("POST", "/agent/paper-count", { contestId, unit: unit.trim(), ballots: Number(paperBallots), counts: list.filter((x) => x.n > 0) }, agent);
    setBusy(false);
    setNote(r.ok ? { kind: "ok", text: "Paper count reported. It cannot be changed." } : { kind: "err", text: errorText(r) });
    await load();
  };

  const nameOf = (candId: string) => races.flatMap((r) => r.candidates).find((c) => c.id === candId)?.name ?? candId.slice(0, 8);
  const officeOf = (raceId: string) => races.find((r) => r.id === raceId)?.office ?? raceId.slice(0, 8);

  return (
    <>
      <h1>Audit and verification</h1>
      <p className="lead">Everything a stranger needs to check the count, without anyone&apos;s identity: the guardians, the encrypted ballots, the totals and the paper kept at polling units.</p>
      <select aria-label="Contest" value={contestId} onChange={(e) => setContestId(e.target.value)}>
        {rows?.map((c) => <option key={c.id} value={c.id}>{c.name}: vote on {when(c.vote_date)}</option>)}
      </select>

      {rec && !rec.secretBallot && <div className="banner">This contest has no secret-ballot record (it used the plain ballot box, or the election has not been keyed yet).</div>}
      {rec?.secretBallot && (
        <>
          <h2>The record</h2>
          <div className="race">
            <div className="small">Guardians: {rec.guardians.filter((g) => g.verified).length} of {rec.n} confirmed · any {rec.quorum} open the total · election {rec.sealed ? "sealed" : "not yet sealed"}</div>
            <div className="small">Ballots: <strong>{rec.ballots.submitted}</strong> submitted, <strong>{rec.ballots.counted}</strong> counted, {rec.ballots.superseded} replaced by a later vote from the same person.</div>
            {rec.manifestHash && <div className="small">Ballot description fingerprint: <code>{rec.manifestHash.slice(0, 32)}…</code></div>}
            {rec.tallies.map((t) => <div className="small" key={t.set}>{t.set === "all" ? "Total of counted ballots" : "Total of polling-unit ballots"}: {t.ballots} ballots · {t.shares} guardian shares · {t.opened ? `OPEN (guardians present: ${t.guardiansPresent?.length ?? "?"})` : "not opened yet"}</div>)}
            <p className="row tight" style={{ marginTop: 10 }}>
              <a href={`${PLATFORM}/public/election/${contestId}/record`} target="_blank" rel="noreferrer"><button className="secondary">Full public record (JSON)</button></a>
              <a href={`${PLATFORM}/public/election/${contestId}/ballots?limit=500`} target="_blank" rel="noreferrer"><button className="secondary">Encrypted ballots (JSON)</button></a>
              <button disabled={busy || !rec.tallies.length} onClick={check}>Run the independent check</button>
            </p>
            {verify && typeof verify === "string" && <div className="msg err">{verify}</div>}
            {verify && typeof verify !== "string" && <div className={`msg ${verify.ok ? "ok" : "err"}`}>{verify.ok ? `Checked ${verify.ballots} ballots: every ballot is a valid encryption and the encrypted total is exactly their sum.` : `Problems: ${verify.problems.join("; ")}`}<div className="muted small">This does not yet check each guardian&apos;s decryption proofs; an independent verifier should (see docs).</div></div>}
          </div>
        </>
      )}

      {contest?.state === "closed" && rec?.secretBallot && (
        <>
          <h2>Paper against electronic</h2>
          <p className="muted small">Every ballot cast at a polling unit also leaves a paper copy in that unit&apos;s box. After voting closes the ward agent counts the paper and reports it once. Any difference is shown here.</p>
          {auditMsg && <div className="msg err">{auditMsg}</div>}
          {audit && (
            <>
              <div className={`msg ${audit.discrepancies === 0 && audit.units.length ? "ok" : audit.discrepancies ? "err" : ""}`}>
                {!audit.units.length ? "No ballots were cast at polling units." : audit.discrepancies === 0 ? "Everything reported so far matches." : `${audit.discrepancies} difference${audit.discrepancies > 1 ? "s" : ""} to explain.`}
              </div>
              {audit.units.length > 0 && (
                <table className="t"><thead><tr><th>Polling unit</th><th>Paper</th><th>Electronic</th><th /></tr></thead><tbody>
                  {audit.units.map((u) => <tr key={u.unit}><td>{u.unit}</td><td>{u.paperBallots ?? "…"}</td><td>{u.electronicBallots}</td><td><span className={`pill ${u.status === "match" ? "vetted" : u.status === "mismatch" ? "flagged" : "mixed"}`}>{STATUS[u.status]}</span></td></tr>)}
                </tbody></table>
              )}
              {audit.choices && (
                <>
                  <h3>Choices (all polling units together)</h3>
                  <table className="t"><thead><tr><th>Office</th><th>Candidate</th><th>Paper</th><th>Electronic</th><th /></tr></thead><tbody>
                    {audit.choices.map((c) => <tr key={c.raceId + c.candidacyId}><td>{officeOf(c.raceId)}</td><td>{nameOf(c.candidacyId)}</td><td>{c.paper}</td><td>{c.electronic}</td><td><span className={`pill ${c.match ? "vetted" : "flagged"}`}>{c.match ? "Matches" : "DOES NOT MATCH"}</span></td></tr>)}
                  </tbody></table>
                </>
              )}
              {!audit.choices && audit.units.length > 0 && <p className="muted small">The choice-level comparison appears once the guardians have opened the polling-unit total.</p>}
            </>
          )}

          <h2>Report the paper count (ward agents)</h2>
          {!agent ? <p className="muted">Sign in as a ward agent on the <a href="/election/unit">Polling unit</a> page first.</p> : (
            <div className="race">
              <p className="small muted">Signed in as {agent.name} (ward {agent.ward}). Count the paper copies in your unit&apos;s box, then report them once.</p>
              <div className="grid2">
                <div><label htmlFor="un">Polling unit</label><input id="un" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="PU-001" list="units" /><datalist id="units">{audit?.units.map((u) => <option key={u.unit} value={u.unit} />)}</datalist></div>
                <div><label htmlFor="pb">Paper ballots in the box</label><input id="pb" inputMode="numeric" value={paperBallots} onChange={(e) => setPaperBallots(e.target.value.replace(/\D/g, ""))} /></div>
              </div>
              {races.map((r) => (
                <fieldset key={r.id} className="race" style={{ margin: "10px 0" }}>
                  <legend style={{ padding: "0 6px", fontWeight: 700 }}>{r.office}</legend>
                  {[...r.candidates.map((c) => ({ key: `${r.id}:${c.id}`, label: c.name })), { key: `${r.id}:abstain`, label: "Abstained / no mark" }].map((x) => (
                    <div className="row tight" key={x.key} style={{ margin: "4px 0" }}><span style={{ minWidth: 200 }}>{x.label}</span><input style={{ maxWidth: 100, minWidth: 80 }} inputMode="numeric" aria-label={`${r.office} ${x.label}`} value={counts[x.key] ?? ""} onChange={(e) => setCounts({ ...counts, [x.key]: e.target.value.replace(/\D/g, "") })} /></div>
                  ))}
                </fieldset>
              ))}
              <button disabled={busy || !unit.trim() || paperBallots === ""} onClick={submitPaper}>Report this unit&apos;s paper count</button>
              {note && <div className={`msg ${note.kind}`}>{note.text}</div>}
            </div>
          )}
        </>
      )}
    </>
  );
}
