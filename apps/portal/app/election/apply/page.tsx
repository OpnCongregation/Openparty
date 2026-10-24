"use client";
import { useEffect, useState } from "react";
import { call, defaultContest, errorText, money, stateLabel, useContests, useDemoKit, when } from "../lib";

interface Race { id: string; office: string; scope: string; formFeeMinor: number }
interface Mine { id: string; state: string; fee_minor: number; office: string; scope: string; contest: string; contest_state: string }

export default function Apply() {
  const { rows } = useContests();
  const [kit, , kitReady] = useDemoKit();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [contestId, setContestId] = useState("");
  const [races, setRaces] = useState<Race[]>([]);
  const [raceId, setRaceId] = useState("");
  const [consent, setConsent] = useState(false);
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (rows ?? []).filter((c) => ["draft", "noticed"].includes(c.state));
  useEffect(() => {
    if (contestId || !kitReady || !open.length) return;
    setContestId(kit && open.some((c) => c.id === kit.contestId) ? kit.contestId : defaultContest(open));
  }, [open.length, kitReady]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!contestId) return;
    (async () => {
      const r = await call("GET", `/public/election/${contestId}`);
      if (r.ok) { setRaces(r.data.races); setRaceId(r.data.races[0]?.id ?? ""); }
    })();
  }, [contestId]);

  const creds = { phone: phone.trim(), pin };
  const run = async (f: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true); setNote(null);
    const r = await f();
    setNote({ kind: r.ok ? "ok" : "err", text: r.text });
    setBusy(false);
  };
  const refresh = async () => { const r = await call("POST", "/election/mine", creds); if (r.ok) setMine(r.data); return r; };

  const submit = () => run(async () => {
    const r = await call("POST", "/election/apply", { ...creds, raceId, consentPublic: consent });
    if (!r.ok) return { ok: false, text: errorText(r) };
    await refresh();
    return { ok: true, text: r.data.state === "listed" ? "You are listed on the ballot. Your name is public." : `Registered. Pay the form fee of ${money(r.data.feeMinor)} to be listed on the ballot.` };
  });
  const pay = (id: string) => run(async () => {
    const r = await call("POST", "/election/pay-form", { ...creds, candidacyId: id });
    if (!r.ok) return { ok: false, text: errorText(r) };
    await refresh();
    return { ok: true, text: "Form fee received. You are now listed on the ballot." };
  });
  const withdraw = (id: string) => run(async () => {
    const r = await call("POST", "/election/withdraw", { ...creds, candidacyId: id });
    if (!r.ok) return { ok: false, text: errorText(r) };
    await refresh();
    return { ok: true, text: "You have withdrawn. A form fee already paid is not refunded by this system." };
  });

  const race = races.find((r) => r.id === raceId);
  const ready = /^\+?\d{8,15}$/.test(creds.phone) && /^\d{4}$/.test(pin);

  return (
    <>
      <h1>Stand for office</h1>
      <p className="lead">Any active member can stand. Some offices charge a fee for the candidate form. Candidates are public.</p>
      {kit && (
        <div className="banner demo">Demo members: {kit.members.slice(0, 4).map((m, i) => <button key={i} className="secondary" style={{ margin: "0 6px 4px 0", padding: "3px 9px" }} onClick={() => { setPhone(m.phone); setPin(m.pin); }}>member {i + 1}</button>)}</div>
      )}

      <div className="grid2">
        <div><label htmlFor="ph">Your phone number</label><input id="ph" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2348012345678" autoComplete="off" /></div>
        <div><label htmlFor="pn">Your 4-digit PIN</label><input id="pn" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="off" /></div>
      </div>

      <label htmlFor="ct">Contest</label>
      <select id="ct" value={contestId} onChange={(e) => setContestId(e.target.value)}>
        {!open.length && <option value="">No contest is taking candidates</option>}
        {open.map((c) => <option key={c.id} value={c.id}>{c.name}: {stateLabel[c.state]}, vote on {when(c.vote_date)}</option>)}
      </select>
      <label htmlFor="rc">Office</label>
      <select id="rc" value={raceId} onChange={(e) => setRaceId(e.target.value)}>
        {!races.length && <option value="">No offices on this ballot yet</option>}
        {races.map((r) => <option key={r.id} value={r.id}>{r.office} ({r.scope}): form fee {money(r.formFeeMinor)}</option>)}
      </select>

      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", color: "var(--fg)", fontSize: ".95rem" }}>
        <input type="checkbox" style={{ width: 20, marginTop: 3 }} checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I understand that as a candidate my name and candidacy are published on the public log, cannot be hidden or removed later, and that I cannot be anonymous.</span>
      </label>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="big" disabled={busy || !ready || !race || !consent} onClick={submit}>{race && race.formFeeMinor > 0 ? `Register (form fee ${money(race.formFeeMinor)})` : "Register as a candidate"}</button>
        <button className="secondary" disabled={busy || !ready} onClick={() => run(async () => { const r = await refresh(); return r.ok ? { ok: true, text: "Your candidacies are below." } : { ok: false, text: errorText(r) }; })}>My candidacies</button>
      </div>
      {note && <div className={`msg ${note.kind}`} role="status">{note.text}</div>}

      {mine && (
        <table className="t" style={{ marginTop: 18 }}>
          <thead><tr><th>Office</th><th>Contest</th><th>Status</th><th /></tr></thead>
          <tbody>
            {!mine.length && <tr><td colSpan={4} className="muted">You have not registered for any office.</td></tr>}
            {mine.map((m) => (
              <tr key={m.id}>
                <td>{m.office}<br /><span className="muted small">{m.scope}</span></td><td>{m.contest}</td>
                <td><span className={`pill ${m.state === "listed" ? "vetted" : m.state === "withdrawn" ? "flagged" : "mixed"}`}>{m.state === "pending_payment" ? `Pay ${money(Number(m.fee_minor))}` : m.state}</span></td>
                <td className="row tight">
                  {m.state === "pending_payment" && ["draft", "noticed"].includes(m.contest_state) && <button disabled={busy} onClick={() => pay(m.id)}>Pay form fee</button>}
                  {m.state !== "withdrawn" && ["draft", "noticed"].includes(m.contest_state) && <button className="secondary" disabled={busy} onClick={() => withdraw(m.id)}>Withdraw</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
