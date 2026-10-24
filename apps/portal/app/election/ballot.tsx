"use client";

export interface BallotRace {
  id: string; office: string; scope: string;
  candidates: { id: string; name: string; status: string }[];
  current: { candidacyId: string | null; revision: number; receipt: string } | null;
}
/** raceId -> candidacy id, "abstain", or undefined (not chosen yet) */
export type Picks = Record<string, string | undefined>;

export const ABSTAIN = "abstain";

/** The ballot paper: one card per office, one choice each, abstain always available. Used online and at the polling unit. */
export function BallotPaper({ races, picks, onPick, big }: { races: BallotRace[]; picks: Picks; onPick: (raceId: string, v: string) => void; big?: boolean }) {
  return (
    <>
      {races.map((r) => (
        <fieldset key={r.id} className="race" style={{ margin: "14px 0" }}>
          <legend style={{ padding: "0 6px", fontWeight: 700, fontSize: big ? "1.25rem" : "1.05rem" }}>{r.office}</legend>
          <div className="meta">{r.scope}{r.current ? ` · you voted here before (change #${r.current.revision + 1} replaces it)` : ""}</div>
          {r.candidates.map((c) => (
            <label key={c.id} className={`cand pick ${picks[r.id] === c.id ? "chosen" : ""}`} style={{ margin: "8px 0", color: "var(--fg)", fontSize: big ? "1.15rem" : "1rem" }}>
              <input type="radio" name={r.id} checked={picks[r.id] === c.id} onChange={() => onPick(r.id, c.id)} />
              <span className="name">{c.name}</span>
              <span className={`pill ${c.status}`}>{c.status === "unvetted" ? "not yet vetted" : c.status}</span>
            </label>
          ))}
          <label className={`cand pick ${picks[r.id] === ABSTAIN ? "chosen" : ""}`} style={{ color: "var(--fg)" }}>
            <input type="radio" name={r.id} checked={picks[r.id] === ABSTAIN} onChange={() => onPick(r.id, ABSTAIN)} />
            <span className="name">Abstain (no choice for this office)</span>
          </label>
        </fieldset>
      ))}
    </>
  );
}

/** Start from what the member voted before, if anything. */
export function initialPicks(races: BallotRace[]): Picks {
  const p: Picks = {};
  for (const r of races) if (r.current) p[r.id] = r.current.candidacyId ?? ABSTAIN;
  return p;
}

export function toChoices(picks: Picks): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(picks)) if (v !== undefined) out[k] = v === ABSTAIN ? null : v;
  return out;
}
