"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminLabel, call, errorText, store, useConfig, useContests, useDemoKit, when, defaultContest, type Identity } from "../lib";

interface View {
  contestId: string; position: number; n: number; quorum: number; step: string;
  sharesPosted: Record<string, boolean>;
  guardians: { adminId: string; position: number; keyPosted: boolean; backupsPosted: boolean; verified: boolean | null }[];
  publicKeys: string[]; backupsForMe: string[];
}
interface Rec { sealed: boolean; manifest: string | null; context: string | null; publicKeys: string[]; quorum: number; tallies: { set: string; tally: string; shares: number; opened: boolean; ballots: number }[] }

const TOOL = 'docker run --rm -v "$PWD:/data" -w /data openparty-eg python -m app.guardian_tool';

/** Download a small JSON file made from public data the platform shows everyone. */
function Download({ name, data, label }: { name: string; data: unknown; label?: string }) {
  const href = useMemo(() => URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" })), [data]);
  return <a href={href} download={name}><button className="secondary" style={{ padding: "4px 10px" }}>{label ?? `Download ${name}`}</button></a>;
}

const STEP_TEXT: Record<string, string> = {
  post_key: "Step 1 of 3: make your key and post its public half.",
  wait_for_keys: "Your key is posted. Waiting for the other guardians to post theirs.",
  post_backups: "Step 2 of 3: make the encrypted backups for the other four guardians.",
  wait_for_backups: "Your backups are posted. Waiting for the others.",
  verify: "Step 3 of 3: check the backups the others made for you.",
  wait_for_verifications: "You have confirmed. Waiting for the others to confirm.",
  complete: "The ceremony is complete. Your part now waits for the count.",
};

export default function Guardian() {
  const { rows } = useContests();
  const cfg = useConfig();
  const [kit, , kitReady] = useDemoKit();
  const [me, setMe] = useState<Identity | null>(null);
  const [custom, setCustom] = useState("");
  const [contestId, setContestId] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const ecs = (kit?.admins ?? []).filter((a) => a.role === "electoral_committee");
  useEffect(() => { setMe(store.get<Identity | null>("op_guardian_me", null)); }, []);
  useEffect(() => {
    if (contestId || !kitReady || !rows) return;
    setContestId(kit?.contestId && rows.some((c) => c.id === kit.contestId) ? kit.contestId : defaultContest(rows));
  }, [rows, kit, kitReady, contestId]);

  const choose = (a: Identity) => { setMe(a); store.set("op_guardian_me", a); setView(null); setNote(null); };
  const useCustom = () => {
    try { const a = JSON.parse(custom) as Identity; if (!a.id || !a.privateKey || a.role !== "electoral_committee") throw new Error(); choose(a); setCustom(""); }
    catch { setNote({ kind: "err", text: 'Paste your signing key as JSON: {"id":"…","name":"…","role":"electoral_committee","ward":null,"privateKey":"…"}' }); }
  };

  const load = useCallback(async () => {
    if (!me || !contestId) return;
    const [v, r] = await Promise.all([call("GET", `/guardian/ceremony/${contestId}`, undefined, me), call("GET", `/public/election/${contestId}/record`)]);
    if (v.ok) { setView(v.data); setNote(null); } else { setView(null); setNote({ kind: "err", text: errorText(v) }); }
    if (r.ok) setRec(r.data);
  }, [me, contestId]);
  useEffect(() => { void load(); }, [load]);

  /** Accept either the tool's whole output file or just the value, and post it. */
  const parseFile = (): any => { try { return JSON.parse(paste); } catch { throw new Error("That is not valid JSON. Paste the whole contents of the file the tool wrote."); } };
  const send = async (path: string, build: (f: any) => unknown, done: string) => {
    setBusy(true); setNote(null);
    try {
      const body = build(parseFile());
      const r = await call("POST", path, body, me!);
      setNote(r.ok ? { kind: "ok", text: done } : { kind: "err", text: errorText(r) });
      if (r.ok) setPaste("");
    } catch (e: any) { setNote({ kind: "err", text: e.message }); }
    setBusy(false);
    await load();
  };

  const demoShares = async (set: string) => {
    if (!kit?.guardianStates?.[me!.id]) return setNote({ kind: "err", text: "This browser does not hold a demo key for you." });
    setBusy(true);
    const r = await call("POST", "/demo/guardians/shares", { contestId, set, adminIds: [me!.id], states: kit.guardianStates });
    setBusy(false);
    setNote(r.ok ? { kind: "ok", text: "Demo: your shares were posted." } : { kind: "err", text: errorText(r) });
    await load();
  };

  const contest = rows?.find((c) => c.id === contestId);
  const tallies = rec?.tallies ?? [];
  const identityLabel = me ? adminLabel(me, kit?.admins ?? [me]) : "";

  return (
    <>
      <h1>Guardians</h1>
      <p className="lead">
        Five members of the electoral committee hold the keys that open the count. Any three can open the <strong>total</strong>; none of you can open a single ballot.
        Your secret key is made and kept on <strong>your own device</strong>: this page never asks for it and the platform never sees it.
      </p>
      {cfg && !cfg.secretBallot && <div className="banner">The ballot-encryption service is not configured on this platform.</div>}

      <h2>You</h2>
      {me ? <p>Signed in as <strong>{identityLabel}</strong> <button className="secondary" style={{ padding: "2px 9px" }} onClick={() => { setMe(null); store.del("op_guardian_me"); setView(null); }}>Switch</button></p> : (
        <>
          {ecs.length > 0 && <div className="who">{ecs.map((a) => <button key={a.id} onClick={() => choose(a)}>{adminLabel(a, kit!.admins)}</button>)}</div>}
          <label htmlFor="gk">Your signing key (JSON)</label>
          <textarea id="gk" rows={3} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder='{"id":"…","name":"…","role":"electoral_committee","ward":null,"privateKey":"…"}' />
          <p><button onClick={useCustom} disabled={!custom}>Sign in</button></p>
        </>
      )}

      <label htmlFor="ct">Contest</label>
      <select id="ct" value={contestId} onChange={(e) => setContestId(e.target.value)}>
        {rows?.map((c) => <option key={c.id} value={c.id}>{c.name}: vote on {when(c.vote_date)}</option>)}
      </select>
      {note && <div className={`msg ${note.kind}`} role="status">{note.text}</div>}

      {view && me && (
        <>
          <h2>The key ceremony</h2>
          <p className="muted">You are guardian <strong>{view.position}</strong> of {view.n}. Any {view.quorum} of you can open the total.</p>
          <table className="t"><thead><tr><th>#</th><th>Key posted</th><th>Backups posted</th><th>Confirmed</th></tr></thead><tbody>
            {view.guardians.map((g) => <tr key={g.adminId}><td>{g.position}{g.adminId === me.id ? " (you)" : ""}</td><td>{g.keyPosted ? "✓" : "…"}</td><td>{g.backupsPosted ? "✓" : "…"}</td><td>{g.verified ? "✓" : "…"}</td></tr>)}
          </tbody></table>
          <div className="msg"><strong>{STEP_TEXT[view.step]}</strong></div>

          {view.step === "post_key" && (
            <div className="race">
              <ol className="small">
                <li>On your own device run: <pre>{`${TOOL} init --id ${me.id} --seq ${view.position} --n ${view.n} --quorum ${view.quorum} --out me.private.json --public-out me.public.json`}</pre></li>
                <li><strong>Keep <code>me.private.json</code> offline and back it up in two places.</strong> It is your key. Never upload it.</li>
                <li>Paste the contents of <code>me.public.json</code> here:</li>
              </ol>
              <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"public":"…"}' />
              <p><button disabled={busy || !paste} onClick={() => send(`/guardian/ceremony/${contestId}/key`, (f) => ({ public: f.public ?? paste }), "Your public key is posted.")}>Post my public key</button></p>
            </div>
          )}

          {view.step === "post_backups" && (
            <div className="race">
              <ol className="small">
                <li><Download name="all-public-keys.json" data={{ public_keys: view.publicKeys }} /> and put it next to your private file.</li>
                <li>Run: <pre>{`${TOOL} backups --private me.private.json --keys all-public-keys.json --out-private me.private.json --out backups.json`}</pre></li>
                <li>Paste the contents of <code>backups.json</code>:</li>
              </ol>
              <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"backups":["…","…","…","…"]}' />
              <p><button disabled={busy || !paste} onClick={() => send(`/guardian/ceremony/${contestId}/backups`, (f) => ({ backups: f.backups }), "Your backups are posted.")}>Post my backups</button></p>
            </div>
          )}

          {view.step === "verify" && (
            <div className="race">
              <ol className="small">
                <li><Download name="backups-for-me.json" data={{ backups: view.backupsForMe }} /></li>
                <li>Run: <pre>{`${TOOL} receive --private me.private.json --backups backups-for-me.json --out-private me.private.json --out verifications.json`}</pre></li>
                <li>If it says <strong>all backups verified</strong>, paste the contents of <code>verifications.json</code>. If it does not, <strong>stop and tell the secretary</strong>.</li>
              </ol>
              <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"verifications":[…],"all_verified":true}' />
              <p><button disabled={busy || !paste} onClick={() => send(`/guardian/ceremony/${contestId}/verify`, (f) => ({ all_verified: f.all_verified, verifications: f.verifications }), "Confirmed. When all five have confirmed, the election key is made.")}>Confirm</button></p>
            </div>
          )}
          {cfg?.demoGuardians && ["post_key", "post_backups", "verify"].includes(view.step) && <p className="muted small">Demo mode: the desk&apos;s <a href="/election/desk">&ldquo;run all five guardians&apos; steps&rdquo;</a> button does this for you.</p>}

          <h2>Opening the count</h2>
          {!tallies.length && <p className="muted">Nothing to open yet. After voting closes and the encrypted ballots are added up, the tally appears here.</p>}
          {tallies.map((t) => (
            <div className="race" key={t.set}>
              <h3 style={{ marginTop: 0 }}>{t.set === "all" ? "The total of every counted ballot" : "The total of ballots cast at polling units (for the paper audit)"}</h3>
              <div className="meta">{t.ballots} ballots · {t.shares} of {view.quorum} guardians have posted · {t.opened ? "OPEN" : "closed"}</div>
              {t.opened ? <div className="small">The total is open. See the <a href="/election/audit">audit page</a>.</div> : view.sharesPosted[t.set] ? <div className="small">You have posted your shares. Waiting for {Math.max(0, view.quorum - t.shares)} more.</div> : (
                <>
                  <ol className="small">
                    <li>Download <Download name="manifest.json" data={{ manifest: rec!.manifest }} /> <Download name="context.json" data={{ context: rec!.context }} /> <Download name={`tally-${t.set}.json`} data={{ tally: t.tally }} /> <Download name="all-public-keys.json" data={{ public_keys: view.publicKeys }} /></li>
                    <li>Run: <pre>{`${TOOL} shares --private me.private.json --manifest manifest.json --context context.json --tally tally-${t.set}.json --keys all-public-keys.json --out my-shares.json`}</pre></li>
                    <li>Paste the contents of <code>my-shares.json</code>. These open only the <strong>total</strong>:</li>
                  </ol>
                  <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"guardian_id":"…","share":"…","compensated":{…}}' />
                  <p className="row tight">
                    <button disabled={busy || !paste} onClick={() => send(`/guardian/shares/${contestId}/${t.set}`, (f) => f, "Your shares are posted. When three guardians have posted, the total opens.")}>Post my shares</button>
                    {cfg?.demoGuardians && kit?.guardianStates?.[me.id] && <button className="secondary" disabled={busy} onClick={() => demoShares(t.set)}>Demo: post my shares for me</button>}
                  </p>
                </>
              )}
            </div>
          ))}
        </>
      )}
      {contest && !me && <p className="muted">Sign in to see your steps.</p>}
    </>
  );
}
