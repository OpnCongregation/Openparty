"use client";
import { useCallback, useEffect, useState } from "react";

export const PLATFORM = process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:3000";

/** An admin who can sign requests: their id, role and Ed25519 private key (PKCS8, base64). Demo keys come from /demo/seed. */
export interface Identity { id: string; name: string; role: string; ward: string | null; privateKey: string }
export interface DemoMember { phone: string; pin: string; cardNo: string; preview: string }
export interface DemoKit {
  admins: Identity[]; members: DemoMember[]; contestId: string; voteDate: string;
  /** DEMO ONLY: the guardians' private key files, kept here so the demo can open the tally. A real guardian keeps theirs offline. */
  guardianStates?: Record<string, string>;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export interface Reply<T = any> { status: number; ok: boolean; data: T }

/**
 * Talk to the platform. With `who`, the request is signed exactly as the server expects: timestamp, method, path (with query) and the
 * hash of the body, signed by that admin's own key. The timestamp comes from the PLATFORM's clock (a demo can move it).
 */
export async function call<T = any>(method: "GET" | "POST", path: string, body?: unknown, who?: Identity): Promise<Reply<T>> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload) headers["content-type"] = "application/json";
  try {
    if (who) {
      const now = (await (await fetch(`${PLATFORM}/public/time`)).json()).now as string;
      const ts = String(Date.parse(now));
      const key = await crypto.subtle.importKey("pkcs8", b64(who.privateKey), { name: "Ed25519" } as any, false, ["sign"]);
      const sig = await crypto.subtle.sign({ name: "Ed25519" } as any, key, new TextEncoder().encode(`${ts}\n${method}\n${path}\n${await sha256hex(payload ?? "")}`));
      Object.assign(headers, { "x-admin-id": who.id, "x-timestamp": ts, "x-signature": hex(sig) });
    }
    const r = await fetch(`${PLATFORM}${path}`, { method, headers, body: payload });
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    return { status: r.status, ok: r.ok, data };
  } catch (e: any) {
    return { status: 0, ok: false, data: ({ error: "network", message: who && /Ed25519|importKey|algorithm/i.test(String(e?.message)) ? "This browser cannot sign with Ed25519. Use a current Chrome, Edge, Firefox or Safari." : `Could not reach the platform at ${PLATFORM}` }) as T };
  }
}

export const errorText = (r: Reply) => (r.ok ? "" : `${r.data?.message ?? r.data?.error ?? `HTTP ${r.status}`}${r.data?.error && r.data?.message ? ` (${r.data.error})` : ""}`);

/** Local storage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(k: string, fallback: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** The demo kit (fake admins with keys, fake members with PINs) kept in this browser after /demo/seed. */
export function useDemoKit() {
  const [kit, setKit] = useState<DemoKit | null>(null);
  const [ready, setReady] = useState(false); // false until the saved kit has been read from this browser
  useEffect(() => { setKit(store.get<DemoKit | null>("op_demo_kit", null)); setReady(true); }, []);
  const save = useCallback((k: DemoKit | null) => { if (k) store.set("op_demo_kit", k); else store.del("op_demo_kit"); setKit(k); }, []);
  return [kit, save, ready] as const;
}

/** What this deployment can do (is the secret ballot configured? can the demo run the guardians?). */
export interface PlatformConfig { secretBallot: boolean; plainBallotAllowed: boolean; demoGuardians: boolean }
export function useConfig() {
  const [cfg, setCfg] = useState<PlatformConfig | null>(null);
  useEffect(() => { void call<PlatformConfig>("GET", "/public/config").then((r) => setCfg(r.ok ? r.data : { secretBallot: false, plainBallotAllowed: true, demoGuardians: false })); }, []);
  return cfg;
}

export interface ContestRow { id: string; name: string; state: string; vote_date: string; mode: string }
export function useContests() {
  const [rows, setRows] = useState<ContestRow[] | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(async () => {
    const r = await call<ContestRow[]>("GET", "/public/contests");
    if (r.ok) { setRows(r.data); setErr(""); } else setErr(errorText(r));
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { rows, err, reload };
}

/** The contest to show first: the one that is happening, then the soonest unfinished one, then the latest closed one. */
export function defaultContest(rows: ContestRow[]): string {
  const rank = (s: string) => ({ open: 0, noticed: 1, draft: 2, closed: 3 } as Record<string, number>)[s] ?? 4;
  return [...rows].sort((a, b) => rank(a.state) - rank(b.state) || (a.state === "closed" ? b.vote_date.localeCompare(a.vote_date) : a.vote_date.localeCompare(b.vote_date)))[0]?.id ?? "";
}

export const money = (minor: number) => (minor === 0 ? "free" : `₦${(minor / 100).toLocaleString("en-NG")}`);
export const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Several admins can share a role (five electoral-committee members): number them. */
export function adminLabel(a: Identity, all: Identity[]): string {
  const same = all.filter((x) => x.role === a.role);
  const base = ROLE_LABEL[a.role] ?? a.role;
  return same.length > 1 ? `${base} ${same.findIndex((x) => x.id === a.id) + 1}` : base;
}
export const ROLE_LABEL: Record<string, string> = { secretary: "Secretary", electoral_committee: "Electoral committee", auditor: "Auditor", treasurer: "Treasurer", tribunal: "Tribunal", ward_agent: "Ward agent" };

export const stateLabel: Record<string, string> = { draft: "Being set up", noticed: "Notice issued", open: "Voting open", closed: "Closed" };
