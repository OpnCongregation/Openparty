"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Icon, Mark } from "./icons";
import { visibleLinks } from "../lib/modules";
import { usePortal } from "./modules";

type L = [href: string, label: string, icon: string];
// Grouped for a demo: what to show, the voting screens, and the machinery behind them. A page of a module that is off is not listed.
const GROUPS: { title: string; links: L[] }[] = [
  { title: "Demo", links: [["/", "Home", "home"], ["/tour", "Demo tour", "tour"], ["/party", "Party page", "party"], ["/ussd", "Phone (USSD)", "ussd"]] },
  { title: "Voting", links: [
    ["/election", "Candidates and results", "voting"], ["/election/apply", "Stand for office", "apply"], ["/election/vote", "Vote online", "secret"],
    ["/election/unit", "Polling unit", "unit"], ["/election/desk", "Admin desk", "desk"], ["/election/guardian", "Guardians", "guardian"], ["/election/audit", "Public audit", "audit"],
  ] },
  { title: "Under the hood", links: [["/verify", "Log verifier", "verify"], ["/framework", "Framework", "framework"], ["/lab", "Rules lab", "lab"], ["/tests", "Test results", "tests"]] },
];
const ALL = GROUPS.flatMap((g) => g.links.map(([h]) => h));

/** The link for the page being shown: an exact match, or the longest listed prefix (so /election/vote/x lights "Vote online"). */
export const currentLink = (path: string): string | null => {
  if (ALL.includes(path)) return path;
  const hits = ALL.filter((h) => h !== "/" && path.startsWith(h + "/")).sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
};

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  const { modules, demo } = usePortal();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const here = currentLink(path);
  const brand = (
    <a className="brand" href="/">
      <Mark /><span><b>OpenParty</b><small>Demo and test bench</small></span>
    </a>
  );
  return (
    <div className="shell">
      <header className="topbar">
        {brand}
        <button className="menubtn" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(!open)}>
          <Icon name={open ? "close" : "menu"} /> Menu
        </button>
      </header>
      <aside id="sidebar" className={`side${open ? " open" : ""}`} aria-label="Portal">
        {brand}
        <nav>
          {GROUPS.map((g) => {
            const links = visibleLinks(g.links, modules);
            return links.length === 0 ? null : (
              <div className="navgroup" key={g.title}>
                <h6>{g.title}</h6>
                {links.map(([href, label, icon]) => (
                  <a key={href} href={href} className="navlink" aria-current={here === href ? "page" : undefined}><Icon name={icon} />{label}</a>
                ))}
              </div>
            );
          })}
        </nav>
        <p className="foot">Open source, Apache-2.0.<br />Not independently audited. Do not use for real members yet.</p>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="content">
        {demo && (
          <div className="demobar" role="status">
            <b>Demo data</b>
            <span>Everything here is made up: members, admins and the clock. Do not enter real details.</span>
            <time dateTime={demo.now}>virtual date {demo.now.slice(0, 10)}{demo.offsetDays ? ` (+${demo.offsetDays} days)` : ""}</time>
          </div>
        )}
        <main id="main">{children}</main>
        <a className="backlink" href="/">← Portal</a>
      </div>
    </div>
  );
}
