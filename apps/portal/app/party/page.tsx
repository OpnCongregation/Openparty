"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";
const LOG = process.env.NEXT_PUBLIC_TRUSTLOG_URL ?? "http://localhost:8080";

type Settings = Record<string, any>;
interface Profile { name: string; acronym: string; motto: string; headquarters: string; channels: string[]; payment_channels: string[]; source_of_funds: string; creed: string[]; organs: { name: string; sits: string; role: string }[]; national_officers: { office: string; count: number }[]; note?: string }
interface Base { fingerprint: string; layers: { pack: { name: string; version: string; status: string; signature: string } }; party: { settings: Settings; profile: Profile }; packDefaults: Settings; summary: { packRules: number; enforced: number } }
interface Verdict { state: "ok" | "no" | "na" | "wait"; msg: string }

const LANG: Record<string, string> = { en: "English", ha: "Hausa", yo: "Yoruba", ig: "Igbo", pcm: "Nigerian Pidgin", ff: "Fulfulde", kr: "Kanuri", tiv: "Tiv", ibb: "Ibibio", ijc: "Ijaw", bin: "Edo" };
const ACCENTS = [["Forest", "#0b6b3a"], ["Indigo", "#2b3a8f"], ["Ochre", "#a85f00"], ["Crimson", "#9c2a2a"], ["Teal", "#0f5f66"]];

interface Field { key: string; label: string; group: string; kind: "naira" | "int" | "pct" | "select"; options?: string[]; hint?: string }
const FIELDS: Field[] = [
  { key: "dues.standard_annual_minor", label: "Standard dues, per year", group: "Money", kind: "naira" },
  { key: "dues.reduced_annual_minor", label: "Reduced dues, per year", group: "Money", kind: "naira", hint: "students, unemployed, retired" },
  { key: "dues.min_payment_minor", label: "Smallest payment accepted", group: "Money", kind: "naira" },
  { key: "finance.cap_per_donor_minor", label: "Most one donor may give", group: "Money", kind: "naira" },
  { key: "finance.cap_window_days", label: "…counted over (days)", group: "Money", kind: "int" },
  { key: "dues.voting_lapse_months", label: "Voting pauses after unpaid (months)", group: "Members' rights", kind: "int" },
  { key: "proposals.threshold", label: "Signatures to force a response", group: "Members' rights", kind: "int" },
  { key: "proposals.response_days", label: "Days the party has to respond", group: "Members' rights", kind: "int" },
  { key: "ratings.min_to_show", label: "Ratings needed before a score shows", group: "Members' rights", kind: "int" },
  { key: "org.women_target_pct", label: "Women's share target (%)", group: "How we are run", kind: "pct" },
  { key: "org.max_term_years", label: "Years in a term", group: "How we are run", kind: "int" },
  { key: "org.max_terms", label: "Most terms in one office", group: "How we are run", kind: "int" },
  { key: "org.min_states_in_executive", label: "States the executive must come from", group: "How we are run", kind: "int" },
  { key: "primary.default_type", label: "Default way to pick candidates", group: "How we are run", kind: "select", options: ["direct", "consensus"] },
];
const toRaw = (f: Field, ui: string): number | string => (f.kind === "select" ? ui : f.kind === "naira" ? Math.round(Number(ui) * 100) : Number(ui));
const toUi = (f: Field, raw: any): string => (f.kind === "naira" ? String(Number(raw) / 100) : String(raw ?? ""));

const naira = (kobo: number) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 });
const USSD_SCREENS = [
  "Welcome\n1 Join the party\n2 Pay dues\n3 My membership card",
  "Enter your National\nIdentification Number\n(11 digits)",
  "Hello MUS…\nIs this you?\n1 Yes, continue\n2 No, cancel",
  "Your details go on the\nparty register that is\nfiled with INEC.\n1 Visible to members\n2 Anonymous to members",
  "Choose a 4-digit PIN",
  "You have joined.\nCard number OP-9047FE1DF7.\nSee your ward agent to\nbe confirmed.",
];

function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="var(--p-brand)" />
      <path d="M8 11h16M8 16h10M8 21h16" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".9" />
      <path d="M17 17.5l3 3 5.5-7" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function Handset() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % USSD_SCREENS.length), 3400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="handset prise d3" role="img" aria-label="A basic phone showing the USSD steps for joining">
      <div className="spk" />
      <div className="scr"><pre key={i}>{USSD_SCREENS[i]}{i === 1 || i === 4 ? <span className="cur" /> : null}</pre></div>
      <div className="keys">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => <span key={k}>{k}</span>)}</div>
      <div className="cap">any phone · no data · no app</div>
    </div>
  );
}

export default function PartyPage() {
  const [base, setBase] = useState<Base | null>(null);
  const [err, setErr] = useState("");
  const [settings, setSettings] = useState<Settings>({});
  const [brand, setBrand] = useState({ name: "", acronym: "", motto: "", accent: ACCENTS[0][1] });
  const [langs, setLangs] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<Record<string, Verdict>>({});
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState("");
  const [head, setHead] = useState<{ size: number; cos: number; time: string } | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(() => {
    setErr("");
    fetch(`${PLATFORM}/framework`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d: Base) => {
      setBase(d);
      setSettings({ ...d.party.settings });
      setBrand({ name: d.party.profile.name, acronym: d.party.profile.acronym, motto: d.party.profile.motto, accent: ACCENTS[0][1] });
      setLangs([...(d.party.settings["languages.launch"] ?? [])]);
    }).catch((e) => setErr(String(e.message).toLowerCase().includes("fetch") ? `The platform is not reachable at ${PLATFORM}. Start the stack, then reload.` : e.message));
    fetch(`${LOG}/head`).then((r) => r.json()).then((h) => setHead({ size: h.head.size, cos: h.cosignatures.length, time: h.head.time })).catch(() => setHead(null));
  }, []);
  useEffect(load, [load]);

  const S = (k: string) => settings[k];
  const check = useCallback((f: Field, ui: string) => {
    clearTimeout(timers.current[f.key]);
    setVerdict((v) => ({ ...v, [f.key]: { state: "wait", msg: "Checking the law pack…" } }));
    timers.current[f.key] = setTimeout(async () => {
      try {
        const raw = toRaw(f, ui);
        if (f.kind !== "select" && (ui.trim() === "" || Number.isNaN(raw as number))) return setVerdict((v) => ({ ...v, [f.key]: { state: "no", msg: "Enter a number." } }));
        const c = await (await fetch(`${PLATFORM}/framework/check?param=${encodeURIComponent(f.key)}&value=${encodeURIComponent(JSON.stringify(raw))}`)).json();
        let out: Verdict;
        if (!c.known) out = { state: "na", msg: "A party choice: the law sets no limit on it." };
        else if (c.accepted) out = { state: "ok", msg: c.packDefault !== undefined && f.kind === "naira" && f.key.startsWith("finance.") ? `Within the law (legal ceiling ${naira(Number(c.packDefault))}).` : "Allowed by the law pack." };
        else out = { state: "no", msg: String(c.violations?.[0]?.message ?? "Refused by the law pack.").replace(/^.*? breaks /, "Breaks ") };
        setVerdict((v) => ({ ...v, [f.key]: out }));
      } catch { setVerdict((v) => ({ ...v, [f.key]: { state: "na", msg: "Could not reach the platform to check." } })); }
    }, 350);
  }, []);

  function set(f: Field, ui: string) {
    setSettings((s) => ({ ...s, [f.key]: f.kind === "select" ? ui : ui === "" ? "" : toRaw(f, ui) }));
    check(f, ui);
  }
  function reset() { if (!base) return; setSettings({ ...base.party.settings }); setLangs([...(base.party.settings["languages.launch"] ?? [])]); setBrand({ name: base.party.profile.name, acronym: base.party.profile.acronym, motto: base.party.profile.motto, accent: ACCENTS[0][1] }); setVerdict({}); setYaml(""); }
  function loosen() {
    const f = FIELDS.find((x) => x.key === "finance.cap_per_donor_minor")!;
    set(f, "600000000");
    const g = FIELDS.find((x) => x.key === "proposals.threshold")!;
    set(g, "5000");
  }
  function exportYaml() {
    if (!base) return;
    const lines: string[] = [];
    for (const [k, v] of Object.entries(settings)) if (JSON.stringify(v) !== JSON.stringify(base.party.settings[k])) lines.push(`  ${k}: ${JSON.stringify(v)}`);
    if (JSON.stringify(langs) !== JSON.stringify(base.party.settings["languages.launch"])) lines.push(`  languages.launch: ${JSON.stringify(langs)}`);
    const prof = (["name", "acronym", "motto"] as const).filter((k) => brand[k] !== (base.party.profile as any)[k]).map((k) => `  ${k}: ${JSON.stringify(brand[k])}`);
    setYaml(["# Changes to parties/ddpn/settings.yaml", lines.length ? "settings:\n" + lines.join("\n") : "# no setting changes", prof.length ? "profile:\n" + prof.join("\n") : ""].filter(Boolean).join("\n"));
  }
  // Shareable states: /party?configure=1 opens the drawer, &break=1 also tries settings the law refuses.
  const started = useRef(false);
  useEffect(() => {
    if (!base || started.current) return;
    started.current = true;
    const q = new URLSearchParams(window.location.search);
    if (q.get("configure") === "1") setOpen(true);
    if (q.get("break") === "1") { setOpen(true); setTimeout(loosen, 50); }
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = useMemo(() => base ? Object.keys(settings).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(base.party.settings[k])).length + (brand.name !== base.party.profile.name ? 1 : 0) : 0, [settings, base, brand]);

  if (err) return <div className="psite"><div className="pwrap" style={{ padding: "90px 22px" }}><h1>Party page</h1><p className="plead">{err}</p><button className="pbtn" onClick={load}>Try again</button></div></div>;
  if (!base) return <div className="psite"><div className="pwrap" style={{ padding: "90px 22px" }}><p className="pmuted">Loading the party…</p></div></div>;

  const p = base.party.profile;
  const cap = Number(S("finance.cap_per_donor_minor") || 0);
  const legalCap = Number(base.packDefaults["finance.cap_per_donor_minor"] || 0);
  const officers = p.national_officers.reduce((n, o) => n + o.count, 0);
  const stand = brand.motto.replace(/\.$/, "");
  const lastWord = stand.split(" ").slice(-1)[0];
  const lead = stand.split(" ").slice(0, -1).join(" ");
  const signMax = Math.max(Number(S("proposals.threshold") || 1), 1);
  const capPct = legalCap ? Math.min(100, (cap / legalCap) * 100) : 0;
  const overLaw = verdict["finance.cap_per_donor_minor"]?.state === "no";

  const V = ({ k }: { k: string }) => { const v = verdict[k]; return v ? <div className={`pverdict ${v.state === "wait" ? "na" : v.state}`} role="status">{v.state === "ok" ? "✓" : v.state === "no" ? "✕" : "•"} <span>{v.msg}</span></div> : null; };

  return (
    <div className="psite" style={{ ["--p-brand" as any]: brand.accent }}>
      <div className="ptop">
        <div className="pwrap">
          <a className="pbrand" href="#top"><Mark />{brand.acronym}</a>
          <nav className="pnav" aria-label="Sections">
            <a href="#stand">What we stand for</a><a href="#join">Join</a><a href="#dues">Dues</a><a href="#voice">Your voice</a><a href="#run">How we are run</a><a href="#money">Money</a><a href="#rules">The rulebook</a>
          </nav>
          <a className="pbtn small" href="/ussd">Join on a phone →</a>
        </div>
      </div>

      <section className="phero" id="top">
        <div className="pwrap">
          <div>
            <div className="pflag prise">
              <span className="ptag"><i /> Preview · not registered with INEC</span>
              <span className="ptag good"><i /> Law pack {base.layers.pack.name} v{base.layers.pack.version} ({base.layers.pack.status})</span>
            </div>
            <div className="pname prise d1">{brand.name}</div>
            <h1 className="prise d2">{lead} <em>{lastWord}.</em></h1>
            <p className="plead prise d3">A party where the written rules outrank every chairman, governor and backer. Members elect every leader, pay the bills, and can check every result themselves, from a basic phone.</p>
            <div className="pcta prise d4">
              <a className="pbtn" href="/ussd">Join on your phone</a>
              <a className="pbtn ghost" href="#rules">See the rules we run under</a>
            </div>
            <p className="pnote prise d4">This is what a member would see. Every figure on the page comes from the party's settings and has been checked against the law pack; use <b>Configure</b> (bottom right) to change them and watch the page and the law's verdict respond.</p>
          </div>
          <Handset />
        </div>
      </section>

      <div className="pfacts">
        <div className="pwrap">
          <div className="pfact"><b>{naira(Number(S("dues.min_payment_minor")))}</b><span>smallest payment that keeps you in good standing</span></div>
          <div className="pfact"><b>{naira(cap)}</b><span>the most any one donor can give in {Number(S("finance.cap_window_days")) === 365 ? "a year" : `${S("finance.cap_window_days")} days`}</span></div>
          <div className="pfact"><b>{S("org.min_states_in_executive")}+ states</b><span>every executive must come from at least this many, plus the FCT</span></div>
          <div className="pfact"><b>{S("org.women_target_pct")}%</b><span>women's share we publish a target for, and report against</span></div>
        </div>
      </div>

      <section className="psec" id="stand">
        <div className="pwrap">
          <div className="pkicker">What we stand for</div>
          <h2>{p.creed.length} articles every officer signs.</h2>
          <p className="psub">Not slogans: each one is backed by something the system does or refuses to do.</p>
          <div className="pcreed">
            {p.creed.map((c, i) => {
              const [title, ...rest] = c.split(/\.\s(.+)/);
              return (
                <div className="pclause" key={i}>
                  <div className="n">{String(i + 1).padStart(2, "0")}</div>
                  <div><h3>{title}.</h3><p>{rest.join(" ")}</p></div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="psec" id="join">
        <div className="pwrap">
          <div className="pkicker">Joining</div>
          <h2>Four steps. No app. No data bundle.</h2>
          <div className="psteps">
            <div className="pstep"><h3>Dial</h3><p>Open the party's USSD menu on any phone and choose “Join the party”.</p></div>
            <div className="pstep"><h3>Prove who you are</h3><p>Enter your NIN once. One NIN, one membership: duplicates are refused.</p></div>
            <div className="pstep"><h3>Choose your privacy</h3><p>Visible to members or anonymous to them. The law still requires your details on the register filed with INEC, and we tell you so.</p></div>
            <div className="pstep"><h3>Get your card</h3><p>Set a PIN, receive your card number, and a ward agent confirms you in person.</p></div>
          </div>
          <div className="pchips" aria-label="Ways in">{p.channels.map((c) => <span className="pchip on" key={c}>{c.toUpperCase()}</span>)}</div>
          <h2 style={{ fontSize: "1.5rem", marginTop: 40 }}>In your language</h2>
          <div className="pchips">
            {(base.party.settings["languages.launch"] as string[]).map((l) => <span key={l} className={`pchip ${langs.includes(l) ? "on" : ""}`}>{LANG[l] ?? l}</span>)}
            {(S("languages.second_wave") as string[]).map((l) => <span key={l} className="pchip" title="second wave">{LANG[l] ?? l}</span>)}
          </div>
          <p className="pnote">Filled chips launch first; the others follow. Wording is written by speakers, never machine-translated.</p>
        </div>
      </section>

      <section className="psec" id="dues">
        <div className="pwrap">
          <div className="pkicker">What membership costs</div>
          <h2>Members pay, so members own.</h2>
          <p className="psub">Dues are the party's main income. No backer can buy it, and nobody is ever struck off for being broke.</p>
          <div className="pdues">
            <div className="pprice main"><h3>Standard</h3><div className="amt">{naira(Number(S("dues.standard_annual_minor")))}</div><div className="per">a year · about {naira(Number(S("dues.standard_annual_minor")) / 12)} a month</div></div>
            <div className="pprice"><h3>Reduced</h3><div className="amt">{naira(Number(S("dues.reduced_annual_minor")))}</div><div className="per pmuted">a year · students, unemployed and retired members</div></div>
            <div className="pprice"><h3>Smallest payment</h3><div className="amt">{naira(Number(S("dues.min_payment_minor")))}</div><div className="per pmuted">pay it in pieces, by card, transfer, USSD or mobile money</div></div>
          </div>
          <div className="prule">Voting rights pause after <b>{S("dues.voting_lapse_months")} months</b> unpaid. Membership itself is never cancelled for unpaid dues, and one payment restores your vote.</div>
        </div>
      </section>

      <section className="psec" id="voice">
        <div className="pwrap">
          <div className="pkicker">Your voice</div>
          <h2>If enough of you ask, they must answer.</h2>
          <div className="pvoice">
            <div className="pcard">
              <h3>Petitions with a deadline</h3>
              <p>When <b>{S("proposals.threshold")}</b> members sign a proposal it is queued for formal consideration, and the leadership has <b>{S("proposals.response_days")} days</b> to respond in public.</p>
              <div className="pmeter" aria-hidden="true"><i style={{ ["--w" as any]: "62%" }} /></div>
              <div className="pmono pmuted">example: {Math.round(signMax * 0.62)} of {signMax} signatures · one signature per member</div>
            </div>
            <div className="pcard">
              <h3>Ratings that cannot be gamed</h3>
              <ul className="plist">
                <li>Only verified members rate: one person, one rating.</li>
                <li>A score always shows how many people gave it, with their comments and history.</li>
                <li>Member ratings and public ratings are shown apart.</li>
                <li>Ratings never decide who may stand: the law forbids party-made hurdles.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="psec" id="run">
        <div className="pwrap">
          <div className="pkicker">How we are run</div>
          <h2>Power is split, and terms end.</h2>
          <div className="pgov">
            <div className="porgan">
              {p.organs.map((o) => <div key={o.name}><b>{o.name}</b><span>{o.sits}</span><em>{o.role}</em></div>)}
            </div>
            <div className="poff">
              <h3>{officers} national officers</h3>
              <table><tbody>{p.national_officers.map((o) => <tr key={o.office}><td>{o.office}</td><td>×{o.count}</td></tr>)}</tbody></table>
              <p className="pnote" style={{ marginTop: 12 }}>{p.note}</p>
              <div className="pgauge"><div className="lbl"><span>Women's share target</span><b>{S("org.women_target_pct")}%</b></div><div className="pmeter"><i style={{ ["--w" as any]: `${Math.min(100, Number(S("org.women_target_pct") || 0))}%` }} /></div></div>
              <p className="pnote">{S("org.max_term_years")}-year terms, at most {S("org.max_terms")} in the same office. {S("org.chairman_secretary_different_zone") ? "Chairman and Secretary must come from different zones." : ""} Headquarters: {p.headquarters}.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="psec" id="money">
        <div className="pwrap">
          <div className="pkicker">Where the money comes from</div>
          <h2>No godfathers: a hard ceiling on any one donor.</h2>
          <div className="pmoney">
            <div className="pcard">
              <h3>One donor, one ceiling</h3>
              <div className="pbars">
                <div className="pbar law"><div className="top"><span>The legal ceiling (Electoral Act 2026 s.94)</span><b>{naira(legalCap)}</b></div><div className="track"><i style={{ ["--w" as any]: "100%" }} /></div></div>
                <div className="pbar"><div className="top"><span>{brand.acronym}'s own cap {overLaw && <span className="pstamp">THE LAW SAYS NO</span>}</span><b>{naira(cap)}</b></div><div className="track"><i style={{ ["--w" as any]: `${Math.max(1.5, capPct)}%`, background: overLaw ? "var(--p-bad)" : undefined }} /></div></div>
              </div>
              <p className="pnote">Counted over {S("finance.cap_window_days")} days. Every donor is recorded by name, address and occupation, as the law requires; only party leaders are blinded to who gave.</p>
            </div>
            <div className="pcard">
              <h3>Only Nigerian money</h3>
              <p>{p.source_of_funds}</p>
              <div className="pchips">{p.payment_channels.map((c) => <span className="pchip" key={c}>{c.replace("_", " ")}</span>)}</div>
            </div>
          </div>
          {head && (
            <div className="pledger">
              <div style={{ position: "relative", zIndex: 1 }}>
                <h3>Everything important leaves a public trace.</h3>
                <p>Joins, payments, rule changes and notices go on a public, tamper-evident ledger that independent witnesses copy and sign. Anyone can check it in their browser; no personal data is on it.</p>
                <p style={{ margin: "18px 0 0" }}><a className="pbtn" href="/">Verify the ledger yourself →</a></p>
              </div>
              <div className="row2">
                <div><div className="big">{head.size.toLocaleString()}</div><span>entries so far</span></div>
                <div><div className="big">{head.cos}</div><span>witness co-signatures</span></div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="psec" id="rules">
        <div className="pwrap">
          <div className="pkicker">The rulebook behind this page</div>
          <h2>A party can be stricter than the law, never looser.</h2>
          <p className="psub">This page is generated from three layers: an international floor of democratic standards, the country's law pack ({base.summary.packRules} rules, {base.summary.enforced} enforced by code), and the party's own settings. Change a setting and the law pack answers immediately.</p>
          <div className="pchips">
            <a className="pbtn ghost small" href="/framework">Read every rule, with citations</a>
            <a className="pbtn ghost small" href="/lab">Watch the rules run in the lab</a>
            <a className="pbtn ghost small" href="/ussd">Try joining</a>
          </div>
          <p className="pmono pmuted" style={{ marginTop: 18, wordBreak: "break-all" }}>configuration fingerprint {base.fingerprint}</p>
        </div>
      </section>

      <footer className="pfoot">
        <div className="pwrap">
          <div><b>{brand.name}</b> is a potential party and is <b>not registered with INEC</b>. The logo shown is a placeholder mark; the final logo must avoid state symbols, uniformed services, chieftaincy regalia, ethnic or religious symbols and portraits (s.79(4)).</div>
          <div>The Nigeria law pack is a draft transcribed from the product requirements and has not been reviewed by counsel. Nothing here is legal advice. Identity checks, SMS and payments in this demonstration are simulated.</div>
        </div>
      </footer>

      <button className="pbtn pgear" onClick={() => setOpen(true)} aria-haspopup="dialog">⚙ Configure {changed > 0 && <span className="pcount">{changed}</span>}</button>
      <div className={`pscrim ${open ? "on" : ""}`} onClick={() => setOpen(false)} />
      <aside className={`pdrawer ${open ? "on" : ""}`} role="dialog" aria-label="Configure the party" aria-hidden={!open}>
        <header><h3>Configure {brand.acronym}</h3><button className="pbtn ghost small" onClick={() => setOpen(false)}>Close</button></header>
        <div className="body">
          <p className="pnote" style={{ marginTop: 14 }}>Nothing is saved. Edit a value: the page changes, and the law pack says whether it would accept it.</p>
          <div className="pgroup ppresets">
            <button className="pbtn ghost small" onClick={reset}>Reset to {p.acronym}</button>
            <button className="pbtn ghost small" onClick={loosen}>Try breaking the law</button>
          </div>

          <div className="pgroup">
            <h4>Identity</h4>
            <div className="pfield"><label>Party name</label><input type="text" value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} /></div>
            <div className="pfield"><label>Acronym</label><input type="text" value={brand.acronym} maxLength={8} onChange={(e) => setBrand({ ...brand, acronym: e.target.value.toUpperCase() })} /></div>
            <div className="pfield"><label>Motto</label><input type="text" value={brand.motto} onChange={(e) => setBrand({ ...brand, motto: e.target.value })} /></div>
            <div className="pfield"><label>Colour</label><div className="pswatches">{ACCENTS.map(([n, c]) => <button key={c} title={n} aria-label={n} className={`pswatch ${brand.accent === c ? "on" : ""}`} style={{ background: c }} onClick={() => setBrand({ ...brand, accent: c })} />)}</div></div>
          </div>

          {["Money", "Members' rights", "How we are run"].map((g) => (
            <div className="pgroup" key={g}>
              <h4>{g}</h4>
              {FIELDS.filter((f) => f.group === g).map((f) => (
                <div key={f.key} className={`pfield ${verdict[f.key]?.state === "no" ? "bad" : ""}`}>
                  <label htmlFor={f.key}><span>{f.label}{f.hint ? <small> {f.hint}</small> : null}</span><small>{f.kind === "naira" ? "₦" : f.kind === "pct" ? "%" : ""}</small></label>
                  {f.kind === "select"
                    ? <select id={f.key} value={String(S(f.key))} onChange={(e) => set(f, e.target.value)}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
                    : <input id={f.key} type="number" min={0} value={toUi(f, S(f.key))} onChange={(e) => set(f, e.target.value)} />}
                  <V k={f.key} />
                </div>
              ))}
            </div>
          ))}

          <div className="pgroup">
            <h4>Launch languages</h4>
            <div className="pchips" style={{ marginTop: 0 }}>
              {Object.keys(LANG).map((l) => <button key={l} className={`pchip ${langs.includes(l) ? "on" : ""}`} style={{ cursor: "pointer", font: "inherit" }} onClick={() => setLangs((x) => (x.includes(l) ? x.filter((y) => y !== l) : [...x, l]))}>{LANG[l]}</button>)}
            </div>
          </div>
          {yaml && <pre className="pyaml">{yaml}</pre>}
        </div>
        <div className="foot">
          <button className="pbtn small" onClick={exportYaml}>Show as settings.yaml</button>
          {yaml && <button className="pbtn ghost small" onClick={() => navigator.clipboard?.writeText(yaml)}>Copy</button>}
          <span className="pmono pmuted">{changed} change{changed === 1 ? "" : "s"}</span>
        </div>
      </aside>
    </div>
  );
}
