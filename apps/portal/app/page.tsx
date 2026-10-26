"use client";
import { Icon } from "./icons";
import { usePortal } from "./modules";
import type { Modules } from "../lib/modules";

interface Card { key: string; module: keyof Modules | null; icon: string; title: string; line: string; href: (m: Modules) => string; go: string }

// One card per thing a visitor can try. A card whose module is off is not shown. Membership is core, so it is always there.
const CARDS: Card[] = [
  { key: "membership", module: null, icon: "members", title: "Membership", line: "One person, one member. Private details stay private, and a member can leave and be forgotten.", href: (m) => (m.ussd ? "/ussd" : "/lab"), go: "Join as a member" },
  { key: "dues", module: "finance", icon: "dues", title: "Dues", line: "Pay dues from any phone. Anonymous, foreign and over-limit money is refused, and every payment is on the record.", href: (m) => (m.ussd ? "/ussd" : "/lab"), go: "Pay dues" },
  { key: "petitions", module: "petitions", icon: "petitions", title: "Petitions", line: "Members raise a proposal. Enough signatures force the leadership to answer in public by a set date.", href: () => "/lab", go: "See it in the rules lab" },
  { key: "ussd", module: "ussd", icon: "ussd", title: "USSD", line: "Join, pay and check your card on a basic phone. No smartphone, no data.", href: () => "/ussd", go: "Pick up the phone" },
  { key: "voting", module: "voting", icon: "voting", title: "Voting", line: "Candidates are vetted, members vote online, at a polling unit or by phone, and results are published.", href: () => "/election", go: "See the election" },
  { key: "secret", module: "secret_ballot", icon: "secret", title: "Secret ballot", line: "Votes are sealed. Any 3 of 5 guardians open the count. Anyone can run the check.", href: () => "/election/audit", go: "Run the public check" },
];

export default function Home() {
  const { modules, failed } = usePortal();
  const shown = modules ? CARDS.filter((c) => c.module === null || modules[c.module]) : [];
  return (
    <>
      <section className="hero">
        <p className="eyebrow">OpenParty · demo and test bench</p>
        <h1>The rulebook a party <em>cannot</em> quietly break.</h1>
        <p className="lead">OpenParty puts a party&apos;s members, money and votes under its own written rules, and leaves a public record that anyone can check.</p>
        <div className="cta">
          <a className="btn" href="/tour">Take the guided tour</a>
          <a className="btn secondary" href="/verify">Check the public log</a>
        </div>
      </section>

      <h2>Try a module</h2>
      {failed && <div className="card badcard" role="alert">The platform is not reachable, so this page cannot tell which modules are on. Start the stack, then reload.</div>}
      {!modules && !failed && <p className="muted">Checking which modules are on…</p>}
      <div className="mcards">
        {modules && shown.map((c, i) => (
          <a key={c.key} className="mcard" href={c.href(modules)} style={{ ["--i" as string]: i }}>
            <div className="top"><span className="ico"><Icon name={c.icon} size={22} /></span><span className={`badge ${c.module === null ? "info" : "ok"}`}>{c.module === null ? "Core" : "On"}</span></div>
            <h3>{c.title}</h3>
            <p>{c.line}</p>
            <span className="go">{c.go} →</span>
          </a>
        ))}
      </div>
      {modules && (
        <p className="corestrip">
          <span className="badge info">Always on</span> The trust log, approvals and law pack checks.
          <a href="/verify">Log verifier</a> · <a href="/framework">Framework</a>
        </p>
      )}
    </>
  );
}
