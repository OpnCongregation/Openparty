"use client";
import { useRef, useState } from "react";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

export default function Ussd() {
  const [phone, setPhone] = useState("+2348055550000");
  const [path, setPath] = useState<string[]>([]);
  const [screen, setScreen] = useState("");
  const [input, setInput] = useState("");
  const [live, setLive] = useState(false);
  const [err, setErr] = useState("");
  const session = useRef("");

  async function send(next: string[]) {
    setErr("");
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
      setPath(next);
      setInput("");
    } catch (e: any) { setErr(`Platform unreachable at ${PLATFORM}: ${e.message}`); }
  }

  return (
    <>
      <h1>USSD simulator</h1>
      <p className="lead">Dial as a feature-phone user would. Talks to the platform's <code>/ussd</code> webhook, the same one a gateway calls.</p>
      <div className="phone">
        <div className="row" style={{ marginBottom: 8 }}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Phone number" />
        </div>
        <div className="screen" aria-live="polite">{screen || "Press Dial to start"}</div>
        {live ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (input) send([...path, input]); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} autoFocus aria-label="Your answer" />
            <button>Send</button>
          </form>
        ) : (
          <button onClick={() => send([])}>{screen ? "Dial again" : "Dial"}</button>
        )}
      </div>
      {err && <p className="bad">{err}</p>}
    </>
  );
}
