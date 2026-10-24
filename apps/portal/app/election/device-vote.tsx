"use client";
import { useEffect, useState } from "react";
import { BallotPaper, toChoices, type BallotRace, type Picks } from "./ballot";
import { call, defaultContest, errorText, useContests, when } from "./lib";
import { castAnonymously, createDeviceIdentity, forgetIdentity, importDeviceIdentity, savedIdentities } from "./semaphore-client";

/**
 * Vote anonymously from this device. The identity (a secret) is made and kept in this browser; the platform only ever learns its public
 * commitment, once, when the member proves who they are with their PIN. Casting afterwards needs no login at all: the browser proves
 * "I am on this contest's list of voters" in zero knowledge and sends the choices with the proof. The platform cannot tell whose ballot it is.
 */
export function DeviceVote({ phone, pin, preferred }: { phone: string; pin: string; preferred?: string }) {
  const { rows } = useContests();
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [me, setMe] = useState("");
  const [contestId, setContestId] = useState("");
  const [races, setRaces] = useState<BallotRace[]>([]);
  const [sealed, setSealed] = useState<boolean | null>(null);
  const [picks, setPicks] = useState<Picks>({});
  const [backup, setBackup] = useState("");
  const [importText, setImportText] = useState("");
  const [status, setStatus] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [receipt, setReceipt] = useState<{ code: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshSaved = () => { const s = savedIdentities(); setSaved(s); setMe((m) => (m && s[m] ? m : Object.keys(s)[0] ?? "")); };
  useEffect(refreshSaved, []);

  const open = (rows ?? []).filter((c) => c.state === "open");
  useEffect(() => { if (!contestId && open.length) setContestId(preferred && open.some((c) => c.id === preferred) ? preferred : defaultContest(open)); }, [open.length, preferred]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!contestId) return;
    setReceipt(null); setPicks({});
    (async () => {
      const r = await call("GET", `/public/election/${contestId}`);
      if (!r.ok) return;
      setSealed(!!r.data.sealed);
      setRaces(r.data.races.filter((x: any) => x.candidates.length).map((x: any) => ({ id: x.id, office: x.office, scope: x.scope, candidates: x.candidates.map((c: any) => ({ id: c.id, name: c.name, status: c.status })), current: null })));
    })();
  }, [contestId]);

  const ready = /^\+?\d{8,15}$/.test(phone.trim()) && /^\d{4}$/.test(pin);
  const setup = async () => {
    setBusy(true); setNote(null);
    const r = await createDeviceIdentity(phone.trim(), pin);
    setBusy(false);
    if (!r.ok) return setNote({ kind: "err", text: r.error });
    setBackup(r.backup); refreshSaved(); setMe(phone.trim());
    setNote({ kind: "ok", text: "This device now holds your voting identity. Only its public half was sent to the party." });
  };
  const doImport = async () => {
    const r = await importDeviceIdentity(phone.trim(), importText);
    setNote(r.ok ? { kind: "ok", text: "Identity imported on this device." } : { kind: "err", text: r.error });
    if (r.ok) { setImportText(""); refreshSaved(); setMe(phone.trim()); }
  };
  const cast = async () => {
    setBusy(true); setNote(null); setStatus("");
    try {
      const r = await castAnonymously(contestId, toChoices(picks), me, setStatus);
      if (r.ok) setReceipt({ code: r.receipt!, revision: r.revision! }); else setNote({ kind: "err", text: r.error! });
    } catch (e: any) { setNote({ kind: "err", text: `Could not make the proof: ${e?.message ?? e}` }); }
    setBusy(false); setStatus("");
  };

  const unanswered = races.filter((r) => picks[r.id] === undefined).length;
  const phones = Object.keys(saved);

  return (
    <section className="race" aria-label="Vote anonymously from this device">
      <h2 style={{ marginTop: 0 }}>Vote anonymously from this device</h2>
      <p className="small muted">The strongest way to vote. You prove you are a voter without saying which one, and send your choices with no login. Not even the party&apos;s own systems can tell whose ballot it is.</p>

      <details open={!phones.length || !!backup}>
        <summary><strong>1. Set up this device</strong> <span className="muted small">(once, before the election is sealed)</span></summary>
        <p className="small">Enter your phone number and PIN above, then press the button. Your browser makes a secret identity and keeps it; only the public half is registered.</p>
        <p className="row tight">
          <button disabled={busy || !ready} onClick={setup}>Make my identity on this device</button>
          {phones.length > 0 && <span className="muted small">Identities on this device: {phones.join(", ")}</span>}
        </p>
        {backup && (
          <div className="msg">
            <strong>Back this up.</strong> If you lose this device you cannot vote anonymously; a ward agent can reset you before the election is sealed. Keep this text somewhere private; anyone who has it can vote as you.
            <textarea readOnly rows={3} value={backup} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}
        <details><summary className="small muted">I already have an identity from another device</summary>
          <textarea rows={2} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste your identity backup" />
          <button className="secondary" disabled={!importText || !ready} onClick={doImport}>Import for the phone number above</button>
        </details>
      </details>

      <h3>2. Vote</h3>
      {!phones.length && <p className="muted small">Set up this device first.</p>}
      {phones.length > 0 && (
        <>
          <div className="grid2">
            <div><label htmlFor="dv-id">Identity on this device</label><select id="dv-id" value={me} onChange={(e) => setMe(e.target.value)}>{phones.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
            <div><label htmlFor="dv-ct">Contest</label><select id="dv-ct" value={contestId} onChange={(e) => setContestId(e.target.value)}>{!open.length && <option value="">No contest is open</option>}{open.map((c) => <option key={c.id} value={c.id}>{c.name}, vote on {when(c.vote_date)}</option>)}</select></div>
          </div>
          {contestId && sealed === false && <div className="msg">This contest is not a secret-ballot election, so there is no anonymous voting for it. Use your phone number and PIN below.</div>}
          {contestId && sealed && !receipt && (
            <>
              <BallotPaper races={races} picks={picks} onPick={(r, v) => setPicks((p) => ({ ...p, [r]: v }))} />
              <p className="row">
                <button className="big" disabled={busy || unanswered > 0 || !races.length} onClick={cast}>Cast anonymously</button>
                {unanswered > 0 && <span className="muted small">Choose a candidate, or abstain, in {unanswered} more office{unanswered > 1 ? "s" : ""}.</span>}
                <button className="secondary" disabled={busy} onClick={() => { if (confirm(`Remove the identity for ${me} from this device? You will need your backup to vote anonymously again.`)) { forgetIdentity(me); refreshSaved(); } }}>Remove identity from this device</button>
              </p>
              {status && <div className="msg" role="status">{status}</div>}
            </>
          )}
        </>
      )}
      {note && <div className={`msg ${note.kind}`} role="status">{note.text}</div>}
      {receipt && (
        <div className="msg ok" role="status">
          <strong>Your anonymous ballot was counted.</strong>
          <div className="receipt">{receipt.code.slice(0, 8).toUpperCase()}{receipt.revision > 1 ? <span className="muted small"> · change #{receipt.revision}</span> : null}</div>
          <div className="muted small">Ballot code <code>{receipt.code}</code>. Find it on the <a href="/election/audit">public record</a>. It shows a ballot was counted and nothing about who cast it or how.
            You can vote again from this device before voting closes; your last ballot counts. The platform keeps no record that you voted.</div>
          <button className="secondary" onClick={() => { setReceipt(null); setPicks({}); }}>Done</button>
        </div>
      )}
    </section>
  );
}
