"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MODULE_LABEL, moduleForPath, type Modules } from "../lib/modules";

const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

export interface PortalState {
  /** Which optional modules are on, or null until loaded (or if the platform cannot be reached). */
  modules: Modules | null;
  failed: boolean;
  /** Set only when the platform runs with DEMO_MODE=1: the virtual date. */
  demo: { now: string; offsetDays: number } | null;
}

const Ctx = createContext<PortalState>({ modules: null, failed: false, demo: null });

/** Asks the platform once what is on and whether it is a demo, and shares the answer with every page. */
export function PortalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PortalState>({ modules: null, failed: false, demo: null });
  useEffect(() => {
    let live = true;
    const json = (path: string) => fetch(`${PLATFORM}${path}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
    Promise.all([
      json("/public/modules").then((d) => ({ modules: d.modules as Modules, failed: false }), () => ({ modules: null, failed: true })),
      json("/demo/state").then((d) => ({ now: String(d.now), offsetDays: Number(d.offsetDays) || 0 }), () => null), // the route only exists in demo mode
    ]).then(([m, demo]) => live && setState({ ...m, demo }));
    return () => { live = false; };
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useModules = () => useContext(Ctx);
export const usePortal = () => useContext(Ctx);

/** Wrap a section. If the page belongs to a module that is off, show a short notice instead of the page. */
export function ModuleGate({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "";
  const need = moduleForPath(path);
  const { modules, failed } = useModules();
  if (need === null) return <>{children}</>;
  if (modules === null) return <p className="muted">{failed ? "The platform is not reachable, so this page cannot tell whether its module is on." : "Checking which modules are on…"}</p>;
  if (!modules[need])
    return (
      <div className="card badcard">
        <h2 style={{ marginTop: 0 }}>{MODULE_LABEL[need]} is not turned on for this party</h2>
        <p>This page belongs to the {MODULE_LABEL[need].toLowerCase()} module, which is switched off in the party settings. See <code>docs/modules.md</code> to turn it on.</p>
      </div>
    );
  return <>{children}</>;
}
