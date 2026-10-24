"use client";
import { useEffect, useState } from "react";
import { call, defaultContest, errorText, money, stateLabel, useContests, useDemoKit, when } from "./lib";

interface Cand { id: string; name: string; status: "vetted" | "flagged" | "mixed" | "unvetted"; vetted: number; flagged: number }
interface Race { id: string; office: string; scope: string; formFeeMinor: number; candidates: Cand[] }
interface Result { raceId: string; office: string; scope: string; ballots: number; abstained: number; eligible: number; winnerId: string | null; tie: boolean; candidates: { candidacyId: string; name: string; votes: number }[] }

const STAMP_TEXT: Record<string, string> = { vetted: "Vetted", flagged: "Flagged", mixed: "Mixed stamps", unvetted: "Not yet vetted" };

export default function Overview() {
  const { rows, err } = useContests();
  const [kit, , kitReady] = useDemoKit();
  const [pick, setPick] = useState("");
  const [races, setRaces] = useState<Race[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (rows && !pick && rows.length && kitReady) setPick(kit && rows.some((c) => c.id === kit.contestId) ? kit.contestId : defaultContest(rows));
  }, [rows, pick, kit, kitReady]);

  useEffect(() => {
    if (!pick) return;
    setResults(null); setMsg("");
    (async () => {
      const r = await call("GET", `/public/election/${pick}`);
      if (!r.ok) return setMsg(errorText(r));
      setRaces(r.data.races);
      if (r.data.state === "closed") {
        const res = await call("GET", `/public/election/${pick}/results`);
        if (res.ok) setResults(res.data.races);
      }
    })();
  }, [pick]);

  const contest = rows?.find((c) => c.id === pick);
  const max = (r: Result) => Math.max(1, ...r.candidates.map((c) => c.votes));

  return (
    <>
      <h1>Candidates and results</h1>
      <p className="lead">Everyone who registers to compete is a candidate. Admins can only add a vetting stamp. Candidates and their names are public.</p>
      <div className="banner"><strong>Early version.</strong> This is the ballot box without the secret-ballot layer: the database links each voter to their choice. It is for trying the flow, not for a real contest. The public log shows only counts and anonymous receipts.</div>

      {err && <div className="msg err">{err}. Is the platform running?</div>}
      {rows && !rows.length && <div className="msg">No contests yet. Open the <a href="/election/desk">admin desk</a> to set one up.</div>}
      {rows && rows.length > 0 && (
        <>
          <label htmlFor="contest">Contest</label>
          <select id="contest" value={pick} onChange={(e) => setPick(e.target.value)}>
            {rows.map((c) => <option key={c.id} value={c.id}>{c.name}: {stateLabel[c.state] ?? c.state}, vote on {when(c.vote_date)}</option>)}
          </select>
        </>
      )}
      {msg && <div className="msg err">{msg}</div>}
      {contest && <p className="muted small">Mode: {contest.mode}. Status: <span className={`pill ${contest.state === "open" ? "open" : ""}`}>{stateLabel[contest.state] ?? contest.state}</span></p>}

      {contest && !races.length && <div className="msg">No offices on the ballot yet.</div>}

      {results
        ? results.map((r) => (
            <section className="race" key={r.raceId} aria-label={r.office}>
              <h3>{r.office}</h3>
              <div className="meta">{r.scope} · {r.ballots} ballots of {r.eligible} on the register · {r.abstained} abstained{r.tie ? " · TIE" : ""}</div>
              {r.candidates.map((c) => (
                <div className="cand" key={c.candidacyId}>
                  <span className="name">{c.name}{r.winnerId === c.candidacyId && " ✓ winner"}</span>
                  <div className={`bar ${r.winnerId === c.candidacyId ? "win" : ""}`}><span style={{ width: `${(c.votes / max(r)) * 100}%` }} /></div>
                  <strong>{c.votes}</strong>
                </div>
              ))}
              {r.tie && <p className="muted small">Tied. Breaking a tie is for the party constitution; this system does not choose.</p>}
            </section>
          ))
        : races.map((r) => (
            <section className="race" key={r.id} aria-label={r.office}>
              <h3>{r.office}</h3>
              <div className="meta">{r.scope} · form fee: {money(r.formFeeMinor)}</div>
              {!r.candidates.length && <p className="muted small">No candidates listed yet.</p>}
              {r.candidates.map((c) => (
                <div className="cand" key={c.id}>
                  <span className="name">{c.name}</span>
                  <span className={`pill ${c.status}`} title={`${c.vetted} vetted, ${c.flagged} flagged`}>{STAMP_TEXT[c.status]}{c.vetted + c.flagged > 0 ? ` (${c.vetted}/${c.flagged})` : ""}</span>
                </div>
              ))}
            </section>
          ))}
      {contest?.state === "open" && <p><a href="/election/vote"><button>Vote now</button></a></p>}
      {contest && ["draft", "noticed"].includes(contest.state) && <p><a href="/election/apply"><button className="secondary">Stand for office</button></a></p>}
      {contest?.state === "open" && <p className="muted small">Results stay hidden while voting is open. They are published when the contest closes.</p>}
    </>
  );
}
