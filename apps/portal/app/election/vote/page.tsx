"use client";
import { useState } from "react";
import { BallotPaper, initialPicks, toChoices, type BallotRace, type Picks } from "../ballot";
import { call, errorText, useConfig, useDemoKit } from "../lib";
import { DeviceVote } from "../device-vote";

interface View { contestId: string; name: string; open: boolean; eligible: boolean; state: string; secret: boolean; voted: { revisions: number } | null; races: BallotRace[] }

export default function Vote() {
  const [kit] = useDemoKit();
  const cfg = useConfig();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [picks, setPicks] = useState<Picks>({});
  const [receipts, setReceipts] = useState<{ raceId: string; receipt: string; revision: number }[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = /^\+?\d{8,15}$/.test(phone.trim()) && /^\d{4}$/.test(pin);

  const load = async () => {
    setBusy(true); setNote(""); setReceipts(null); setView(null);
    const r = await call("POST", "/election/ballot", { phone: phone.trim(), pin });
    setBusy(false);
    if (!r.ok) return setNote(errorText(r));
    setView(r.data.ballot); setPicks(initialPicks(r.data.ballot.races));
  };
  const cast = async () => {
    if (!view) return;
    setBusy(true); setNote("");
    const r = await call("POST", "/election/vote", { phone: phone.trim(), pin, contestId: view.contestId, choices: toChoices(picks) });
    setBusy(false);
    if (!r.ok) return setNote(errorText(r));
    setReceipts(r.data.receipts); setView(null); setPin("");
  };

  const unanswered = view ? view.races.filter((r) => picks[r.id] === undefined).length : 0;

  return (
    <>
      <h1>Vote online</h1>
      <p className="lead">You can change your vote until voting closes; your last ballot counts. Enter your phone number and PIN below; they are used to set up your device or, if you prefer, to vote directly.</p>
      {kit && <div className="banner demo">Demo members: {kit.members.slice(0, 6).map((m, i) => <button key={i} className="secondary" style={{ margin: "0 6px 4px 0", padding: "3px 9px" }} onClick={() => { setPhone(m.phone); setPin(m.pin); setView(null); setReceipts(null); }}>member {i + 1}</button>)}</div>}

      <div className="grid2">
        <div><label htmlFor="ph">Phone number</label><input id="ph" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2348012345678" autoComplete="off" /></div>
        <div><label htmlFor="pn">4-digit PIN</label><input id="pn" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/D/g, ""))} autoComplete="off" /></div>
      </div>

      {cfg?.secretBallot && <DeviceVote phone={phone} pin={pin} preferred={kit?.contestId} />}

      {!receipts && (
        <>
          <h2>{cfg?.secretBallot ? "Or vote with your phone number and PIN" : "Vote"}</h2>
          {cfg?.secretBallot && <p className="small muted">Your vote is still encrypted and secret, but the platform sees who you are while it prepares your ballot. If you set up an anonymous identity on a device, use that device instead.</p>}
          <p><button className="big" disabled={busy || !ready} onClick={load}>{view ? "Reload my ballot" : "Show my ballot"}</button></p>
        </>
      )}
      {note && <div className="msg err" role="alert">{note}</div>}

      {view && !view.open && <div className="msg">Voting is not open for “{view.name}” ({view.state}).</div>}
      {view && view.open && !view.eligible && <div className="msg err">You are not on the register for this contest, or your membership is no longer active, so you cannot vote. See your ward agent.</div>}
      {view && view.open && view.eligible && (
        <div data-ballot="pin">
          <h2>{view.name}</h2>
          {view.secret && <div className="banner demo"><strong>Secret ballot.</strong> Your vote is encrypted before it is stored, and the platform keeps no link between you and your ballot. For the same reason it cannot show you what you chose before.</div>}
          {view.voted && <div className="msg">You have already voted{view.voted.revisions > 1 ? ` (${view.voted.revisions} times)` : ""}. Voting again replaces your earlier ballot completely, so choose in every office.</div>}
          {!view.races.length && <div className="msg">There are no candidates to vote for yet.</div>}
          <BallotPaper races={view.races} picks={picks} onPick={(r, v) => setPicks((p) => ({ ...p, [r]: v }))} />
          {view.races.length > 0 && (
            <p className="row">
              <button className="big" disabled={busy || unanswered > 0} onClick={cast}>{view.races.some((r) => r.current) || view.voted ? "Change my vote" : "Cast my vote"}</button>
              {unanswered > 0 && <span className="muted small">Choose a candidate, or abstain, for {unanswered} more office{unanswered > 1 ? "s" : ""}.</span>}
            </p>
          )}
        </div>
      )}

      {receipts && (
        <div className="msg ok" role="status">
          <strong>Your vote was counted.</strong>
          <p>Keep your receipt. It proves a ballot was counted and says nothing about how you voted.</p>
          {receipts.map((r) => <div key={r.raceId}><div className="receipt">{r.receipt.slice(0, 8).toUpperCase()}{r.revision > 1 ? <span className="muted small"> · change #{r.revision}</span> : null}</div>{r.receipt.length === 64 && <div className="muted small">Ballot code <code>{r.receipt}</code>: you can find it on the <a href="/election/audit">public record</a>. It shows your ballot was counted, and nothing about how you voted.</div>}</div>)}
          <p className="muted small">You can come back and change your vote any time before voting closes. A confirmation was also sent by SMS.</p>
          <button className="secondary" onClick={() => { setReceipts(null); setView(null); }}>Done</button>
        </div>
      )}
    </>
  );
}
