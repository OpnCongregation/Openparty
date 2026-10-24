"use client";
import { useEffect, useState } from "react";
import { BallotPaper, initialPicks, toChoices, type BallotRace, type Picks } from "../ballot";
import { call, errorText, store, useDemoKit, type Identity } from "../lib";

interface View { contestId: string; name: string; open: boolean; eligible: boolean; state: string; secret: boolean; voted: { revisions: number } | null; races: BallotRace[] }

/**
 * A polling-unit terminal run by a ward agent. The agent signs in with their own key; the voter types their own phone and PIN on the
 * device, picks, and casts. Every assisted ballot is recorded with the agent's id, and an agent can only help members of their own ward.
 */
export default function Unit() {
  const [kit] = useDemoKit();
  const [agent, setAgent] = useState<Identity | null>(null);
  const [custom, setCustom] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [picks, setPicks] = useState<Picks>({});
  const [done, setDone] = useState<{ receipt: string; n: number } | null>(null);
  const [tally, setTally] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setAgent(store.get<Identity | null>("op_unit_agent", null)); }, []);
  useEffect(() => { if (!agent && kit) { const a = kit.admins.find((x) => x.role === "ward_agent"); if (a) { setAgent(a); store.set("op_unit_agent", a); } } }, [kit, agent]);

  const useCustom = () => {
    try {
      const a = JSON.parse(custom) as Identity;
      if (!a.id || !a.privateKey || a.role !== "ward_agent") throw new Error();
      setAgent(a); store.set("op_unit_agent", a); setCustom("");
    } catch { setNote('Paste the agent as JSON: {"id":"…","name":"…","role":"ward_agent","ward":"W1","privateKey":"…"}'); }
  };
  const signOut = () => { setAgent(null); store.del("op_unit_agent"); setView(null); };

  const reset = () => { setPhone(""); setPin(""); setView(null); setPicks({}); setDone(null); setNote(""); };

  const load = async () => {
    setBusy(true); setNote("");
    const r = await call("POST", "/election/ballot", { phone: phone.trim(), pin });
    setBusy(false);
    if (!r.ok) return setNote(errorText(r));
    setView(r.data.ballot); setPicks(initialPicks(r.data.ballot.races));
  };
  const cast = async () => {
    if (!view || !agent) return;
    setBusy(true); setNote("");
    const r = await call("POST", "/agent/vote", { phone: phone.trim(), pin, contestId: view.contestId, choices: toChoices(picks) }, agent);
    setBusy(false);
    if (!r.ok) return setNote(errorText(r));
    setTally((n) => n + 1); setDone({ receipt: r.data.receipts[0].receipt.slice(0, 8).toUpperCase(), n: r.data.receipts.length }); setView(null); setPin(""); setPhone("");
  };

  const ready = /^\+?\d{8,15}$/.test(phone.trim()) && /^\d{4}$/.test(pin);
  const unanswered = view ? view.races.filter((r) => picks[r.id] === undefined).length : 0;

  if (!agent)
    return (
      <>
        <h1>Polling unit</h1>
        <p className="lead">This terminal is for ward agents helping members vote in person.</p>
        <div className="msg">Sign in with the agent&apos;s key. {kit ? "" : "In a demo, seed the data on the admin desk first."}</div>
        <label htmlFor="cj">Agent key (JSON)</label>
        <textarea id="cj" rows={4} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder='{"id":"…","name":"…","role":"ward_agent","ward":"W1","privateKey":"…"}' />
        <p><button onClick={useCustom} disabled={!custom}>Sign in</button></p>
        {note && <div className="msg err">{note}</div>}
      </>
    );

  return (
    <>
      <h1>Polling unit</h1>
      <div className="unit">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div><strong>Ward {agent.ward}</strong><div className="muted small">Agent: {agent.name}</div></div>
          <div className="row tight"><span className="pill vetted">{tally} voted at this terminal</span><button className="secondary" onClick={signOut}>Sign out</button></div>
        </div>

        {done && (
          <div className="msg ok" role="status">
            <strong>Vote counted.</strong> Receipt <span className="receipt">{done.receipt}</span>
            <p className="muted small">Offices voted: {done.n}. The receipt does not show the choice. A confirmation SMS was sent.</p>
            <p className="small"><strong>Paper copy:</strong> the voter marks the same choices on the unit&apos;s paper slip, writes the receipt above on it and drops it in the box. After voting closes the agent counts the paper and reports it on the <a href="/election/audit">audit page</a>, where it is compared with the electronic count.</p>
            <button className="big" onClick={reset}>Next voter</button>
          </div>
        )}

        {!done && !view && (
          <>
            <h2>Voter: enter your own details</h2>
            <p className="muted small">Agent: hand the device to the voter. They type their own PIN; you do not see or keep it.</p>
            <div className="grid2">
              <div><label htmlFor="ph">Voter&apos;s phone number</label><input id="ph" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2348012345678" autoComplete="off" /></div>
              <div><label htmlFor="pn">Voter&apos;s 4-digit PIN</label><input id="pn" className="pin" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="off" /></div>
            </div>
            {kit && <p className="small muted">Demo voters: {kit.members.map((m, i) => <button key={i} className="secondary" style={{ margin: "0 5px 4px 0", padding: "2px 8px" }} onClick={() => { setPhone(m.phone); setPin(m.pin); }}>{i + 1}</button>)}</p>}
            <button className="big" disabled={busy || !ready} onClick={load}>Show ballot</button>
          </>
        )}

        {view && !view.open && <div className="msg">Voting is not open ({view.state}).</div>}
        {view && view.open && !view.eligible && <div className="msg err">This member is not on the register for this contest, or is no longer active.</div>}
        {view && view.open && view.eligible && (
          <>
            <h2>{view.name}</h2>
            {view.voted && <div className="msg">This member has already voted. Voting again replaces the earlier ballot completely.</div>}
            <BallotPaper big races={view.races} picks={picks} onPick={(r, v) => setPicks((p) => ({ ...p, [r]: v }))} />
            <div className="row">
              <button className="big" disabled={busy || unanswered > 0 || !view.races.length} onClick={cast}>Cast vote</button>
              <button className="secondary big" onClick={reset}>Cancel</button>
              {unanswered > 0 && <span className="muted small">{unanswered} office{unanswered > 1 ? "s" : ""} left to answer.</span>}
            </div>
          </>
        )}
        {note && <div className="msg err" role="alert">{note}</div>}
      </div>
    </>
  );
}
