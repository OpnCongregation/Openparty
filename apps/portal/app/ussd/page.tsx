"use client";
import { useEffect, useRef, useState } from "react";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

const KEYS: [string, string][] = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

export default function Ussd() {
  const [phone, setPhone] = useState("+2348055550000");
  const [path, setPath] = useState<string[]>([]);
  const [screen, setScreen] = useState("");
  const [input, setInput] = useState("");
  const [dial, setDial] = useState("*384#");
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState(false); // is the network dialog on screen?
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [clock, setClock] = useState("");
  const session = useRef("");
  const replyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (open && live) replyRef.current?.focus(); }, [open, live, screen]);

  async function send(next: string[]) {
    setErr(""); setBusy(true);
    try {
      // A new dial gets a new gateway session id; the platform uses it so a repeated final request cannot pay twice.
      if (next.length === 0 || !session.current) session.current = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // /ussd/sim is the demo route (platform LAB_ENABLED=1). The real /ussd needs the gateway's secret, which a browser must never hold.
      const r = await fetch(`${PLATFORM}/ussd/sim`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sessionId: session.current, phoneNumber: phone, text: next.join("*") }),
      });
      const t = await r.text();
      setScreen(t.replace(/^(CON|END) /, ""));
      setLive(t.startsWith("CON"));
      setOpen(true);
      setPath(next);
      setInput("");
    } catch (e: any) { setErr(`Platform unreachable at ${PLATFORM}: ${e.message}`); } finally { setBusy(false); }
  }

  const press = (k: string) => (open && live ? setInput((v) => v + k) : !open && setDial((v) => v + k));
  const back = () => (open && live ? setInput((v) => v.slice(0, -1)) : !open && setDial((v) => v.slice(0, -1)));
  const reply = () => { if (input && !busy) void send([...path, input]); };
  const close = () => { setOpen(false); setLive(false); setPath([]); setScreen(""); setInput(""); };

  return (
    <>
      <h1>Phone (USSD)</h1>
      <p className="lead">Dial as a feature-phone user would. This talks to the platform&apos;s USSD address, the same one a mobile network calls.</p>
      <div className="phonewrap">
        <div>
          <div className="card">
            <label className="small muted" htmlFor="caller">Caller&apos;s phone number (simulated)</label>
            <input id="caller" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
            <p className="small muted" style={{ margin: "8px 0 0" }}>Each number is a different person. Change it to play someone new.</p>
          </div>
          <div className="card hint">
            <strong>Try this</strong>
            <ol>
              <li>Press the green button to dial.</li>
              <li><b>Join:</b> reply <code>1</code>, then an 11-digit ID such as <code>12345678901</code>, then <code>1</code> to confirm, <code>1</code> or <code>2</code> for visible or anonymous, then a 4-digit PIN twice.</li>
              <li><b>Pay dues:</b> dial again, reply <code>2</code>, your PIN, then an amount in naira, such as <code>100</code>.</li>
            </ol>
            <p className="small muted" style={{ margin: 0 }}>One ID can join only once. Use another number to join again.</p>
          </div>
          {err && <p className="bad" role="alert">{err}</p>}
        </div>

        <div className="phone" aria-label="Simulated phone">
          <div className={`pscreen${open ? " dialing" : ""}`}>
            <span className="pnotch" />
            <div className="pstatus"><span>{clock}</span><span><span className="bars"><i /><i /><i /><i /></span><span className="batt" /></span></div>
            <div className="pclock"><b>{clock}</b><span>Simulated network</span></div>

            <div className="pdial">
              <div className="pdisplay" aria-live="polite">{open ? "" : dial}</div>
              <div className="keys">
                {KEYS.map(([k, sub]) => <button key={k} type="button" onClick={() => press(k)} aria-label={`Key ${k}`}>{k}<small>{sub}</small></button>)}
                <button type="button" className="back" onClick={back} aria-label="Delete">⌫</button>
                <button type="button" className="call" onClick={() => (open ? reply() : void send([]))} disabled={busy} aria-label={open && live ? "Send reply" : "Dial"}>{busy ? "…" : "✆"}</button>
                <button type="button" className="back" onClick={() => (open ? close() : setDial(""))} aria-label={open ? "Close" : "Clear"}>{open ? "✕" : "C"}</button>
              </div>
              <div className="pbar" />
            </div>

            {open && (
              <div className="ussd-dialog" role="dialog" aria-label="Network message">
                <div className="msg" aria-live="polite">{screen}</div>
                {live && (
                  <form onSubmit={(e) => { e.preventDefault(); reply(); }}>
                    <input ref={replyRef} className="reply" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Your answer" autoComplete="off" />
                  </form>
                )}
                <div className="acts">
                  <button type="button" onClick={close}>{live ? "Cancel" : "OK"}</button>
                  {live && <button type="button" onClick={reply} disabled={busy || !input}>Send</button>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
