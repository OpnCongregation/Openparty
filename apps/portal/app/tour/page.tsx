"use client";
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { usePortal } from "../modules";
import type { Modules } from "../../lib/modules";

interface Step {
  id: string;
  title: string;
  short: string;
  needs: keyof Modules | null;
  icon: string;
  why: string;
  todo: string[];
  open: { href: string; label: string };
  /** What to use instead when the module this step needs is off. */
  fallback?: { href: string; label: string };
  tip?: string;
}

const STEPS: Step[] = [
  {
    id: "join", title: "Join the party", short: "One person, one member", needs: "ussd", icon: "members",
    why: "The party checks that you are one real person. A second try with the same ID is refused, so nobody can pad the list.",
    todo: ["Open the phone and press the green button to dial.", "Reply 1 to join, then type an 11-digit ID such as 12345678901.", "Reply 1 to confirm it is you, then 1 (visible) or 2 (anonymous).", "Choose a 4-digit PIN and type it twice."],
    open: { href: "/ussd", label: "Open the phone" }, fallback: { href: "/lab", label: "See membership in the rules lab" },
    tip: "Joining twice with the same ID is refused. That is the point. Change the phone number and ID to try again.",
  },
  {
    id: "dues", title: "Pay dues", short: "Money with rules", needs: "ussd", icon: "dues",
    why: "Dues are how members own the party. Every payment lands on the public record. Anonymous, foreign or over-limit money is refused.",
    todo: ["Dial again on the same phone.", "Reply 2 for dues, then your PIN.", "Enter an amount in naira, such as 100, and follow the prompts."],
    open: { href: "/ussd", label: "Open the phone" }, fallback: { href: "/lab", label: "See the money rules in the rules lab" },
    tip: "Payments are simulated. No real money moves.",
  },
  {
    id: "contest", title: "Open a contest", short: "Paperwork before power", needs: "voting", icon: "desk",
    why: "A contest cannot open until the law's paperwork is done: a notice, a frozen register and receipts. Big steps need two other people to approve.",
    todo: ["On the admin desk, press Load demo data. It creates admins, members and a contest.", "Record the notice receipt, then freeze the register with two approvers.", "Record the register receipt, then move the clock to the vote date."],
    open: { href: "/election/desk", label: "Open the admin desk" }, fallback: { href: "/lab", label: "See the contest gates in the rules lab" },
    tip: "Demo members all use the PIN 1234.",
  },
  {
    id: "vote", title: "Vote", short: "Online, on paper or by phone", needs: "voting", icon: "voting",
    why: "Members vote on the register. A member can change their vote until the contest closes, and gets a receipt.",
    todo: ["Open the vote page and pick a demo member.", "Choose a candidate and cast the ballot.", "Keep the receipt code. You will use it to check later."],
    open: { href: "/election/vote", label: "Cast a vote" },
    tip: "With the secret ballot on, your device makes an anonymous proof of membership first. The platform keeps no link between you and the ballot.",
  },
  {
    id: "count", title: "Count", short: "Guardians open the total", needs: "voting", icon: "guardian",
    why: "Closing a contest needs an approval. With the secret ballot, five guardians each hold a key and any 3 of 5 must work together to open the total. No single person can.",
    todo: ["On the admin desk, close the contest with the required approvals.", "With the secret ballot on, use the demo shortcuts to run the guardians' steps and open the tally.", "Open the results page to see the totals against the register."],
    open: { href: "/election/desk", label: "Back to the admin desk" },
    tip: "The demo shortcuts stand in for five real guardians on five devices.",
  },
  {
    id: "verify", title: "Verify", short: "Check it yourself", needs: null, icon: "verify",
    why: "Anyone can check the result without asking permission. The public check re-runs the proofs. The log verifier checks that nothing on the record was altered.",
    todo: ["Open the log verifier and fetch the head to check its signature and witnesses.", "With the secret ballot on, open the public audit and run the check on the contest."],
    open: { href: "/verify", label: "Open the log verifier" }, fallback: { href: "/election/audit", label: "Run the public audit" },
  },
];

const KEY = "op_tour_done";
const read = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };
const write = (v: string[]) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window: progress is just not remembered */ } };

export default function Tour() {
  const { modules } = usePortal();
  const [now, setNow] = useState(0);
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => setDone(read()), []);
  const on = (s: Step) => s.needs === null || modules?.[s.needs] === true;
  const step = STEPS[now];
  const mark = (id: string) => { const d = done.includes(id) ? done : [...done, id]; setDone(d); write(d); };
  const pct = Math.round((done.filter((d) => STEPS.some((s) => s.id === d)).length / STEPS.length) * 100);
  const live = on(step);

  return (
    <>
      <p className="eyebrow">Guided demo</p>
      <h1>Six steps, start to finish</h1>
      <p className="lead">Join, pay, open a contest, vote, count and verify. Each step says what to do and why the rule matters. Your progress is kept in this browser.</p>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tour progress"><span style={{ width: `${pct}%` }} /></div>
      <p className="small muted">{pct}% done</p>

      <div className="tour">
        <ol className="rail" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={`${i === now ? "now" : ""} ${done.includes(s.id) ? "done" : ""}`}>
              <span className="n"><span>{i + 1}</span></span>
              <button onClick={() => setNow(i)} aria-current={i === now ? "step" : undefined}>{s.title}<small>{on(s) ? s.short : "Module is off"}</small></button>
            </li>
          ))}
        </ol>

        <section className="card stepcard" aria-live="polite">
          <p className="eyebrow">Step {now + 1} of {STEPS.length}</p>
          <h2>{step.title}</h2>
          <p className="why">{step.why}</p>
          {!live && <div className="tip warn" role="note"><span><b>This party has {step.needs === "ussd" ? "the phone (USSD)" : "voting"} switched off.</b> You can still see the rule at work in the rules lab.</span></div>}
          <ol>{step.todo.map((t) => <li key={t}>{t}</li>)}</ol>
          {step.tip && <div className="tip"><Icon name="verify" size={18} /><span>{step.tip}</span></div>}
          <div className="actions">
            {live
              ? <a className="btn" href={step.open.href}>{step.open.label} →</a>
              : step.fallback && <a className="btn secondary" href={step.fallback.href}>{step.fallback.label} →</a>}
            {step.id === "verify" && modules?.secret_ballot && step.fallback && <a className="btn secondary" href={step.fallback.href}>{step.fallback.label}</a>}
            <button className="secondary" onClick={() => { mark(step.id); if (now < STEPS.length - 1) setNow(now + 1); }}>{done.includes(step.id) ? "Next" : now === STEPS.length - 1 ? "Mark done" : "Mark done and continue"}</button>
            {now > 0 && <button className="secondary" onClick={() => setNow(now - 1)}>Back</button>}
          </div>
        </section>
      </div>
    </>
  );
}
