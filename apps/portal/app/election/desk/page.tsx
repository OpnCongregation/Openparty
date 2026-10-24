"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { call, defaultContest, errorText, money, stateLabel, store, useContests, useDemoKit, when, type Identity } from "../lib";

interface Cand { id: string; name: string; state: string; vetted: number; flagged: number; status: string; stamps?: { admin_id: string; verdict: string; note: string | null }[] }
interface Race { id: string; office: string; scope: string; formFeeMinor: number; candidates: Cand[] }
interface Approval { id: string; action: string; by: string; approvedBy: string[] }
interface RegisterRow { id: string; member_count: number; filed: boolean }

const ROLE_LABEL: Record<string, string> = { secretary: "Secretary", electoral_committee: "Electoral committee", auditor: "Auditor", treasurer: "Treasurer", tribunal: "Tribunal", ward_agent: "Ward agent" };
const ACTION_LABEL: Record<string, string> = { "register.freeze": "Freeze the register", "contest.open": "Open voting", "contest.close": "Close voting" };
// Who proposes and who may approve each action (mirrors the platform's rules in admin.ts).
const WHO: Record<string, { propose: string[]; approve: string[]; needed: number }> = {
  "register.freeze": { propose: ["secretary"], approve: ["electoral_committee", "auditor"], needed: 2 },
  "contest.open": { propose: ["electoral_committee"], approve: ["secretary", "auditor"], needed: 2 },
  "contest.close": { propose: ["electoral_committee"], approve: ["secretary", "auditor"], needed: 2 },
};

export default function Desk() {
  const { rows, err, reload } = useContests();
  const [kit, saveKit, kitReady] = useDemoKit();
  const [demo, setDemo] = useState<{ now: string; offsetDays: number } | null | undefined>(undefined);
  const [acting, setActing] = useState<Identity | null>(null);
  const [custom, setCustom] = useState("");
  const [extra, setExtra] = useState<Identity[]>([]);
  const [contestId, setContestId] = useState("");
  const [races, setRaces] = useState<Race[]>([]);
  const [reg, setReg] = useState<RegisterRow | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [receipts, setReceipts] = useState<{ notice?: boolean }>({});
  const [form, setForm] = useState({ office: "National Chairman", scope: "National", fee: "0" });
  const [noticeReceipt, setNoticeReceipt] = useState("INEC-N-0001");
  const [regReceipt, setRegReceipt] = useState("INEC-R-0001");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const identities = useMemo(() => [...(kit?.admins ?? []), ...extra], [kit, extra]);
  const contest = rows?.find((c) => c.id === contestId);

  const say = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 60));

  const loadDemo = useCallback(async () => {
    const r = await call("GET", "/demo/state");
    setDemo(r.ok ? r.data : null);
  }, []);
  useEffect(() => { void loadDemo(); setExtra(store.get<Identity[]>("op_desk_extra", [])); }, [loadDemo]);
  useEffect(() => { if (!acting && identities.length) setActing(identities.find((a) => a.role === "secretary") ?? identities[0]); }, [identities, acting]);
  useEffect(() => {
    if (contestId || !kitReady || !rows) return;
    setContestId(kit?.contestId && rows.some((c) => c.id === kit.contestId) ? kit.contestId : defaultContest(rows));
  }, [rows, kit, kitReady, contestId]);
  useEffect(() => {
    if (!contestId) return;
    setApprovals(store.get<Approval[]>(`op_desk_appr_${contestId}`, []));
    setReceipts(store.get(`op_desk_rcpt_${contestId}`, {}));
  }, [contestId]);

  const refresh = useCallback(async () => {
    if (!contestId) return;
    const [r, g] = await Promise.all([
      acting ? call("GET", `/admin/election/${contestId}`, undefined, acting) : call("GET", `/public/election/${contestId}`),
      call("GET", `/public/registers/${contestId}`),
    ]);
    if (r.ok) setRaces(r.data.races);
    setReg(g.ok && g.data.length ? g.data[0] : null);
    await reload();
  }, [contestId, acting, reload]);
  useEffect(() => { void refresh(); }, [refresh]);

  const saveApprovals = (a: Approval[]) => { setApprovals(a); store.set(`op_desk_appr_${contestId}`, a); };
  const markReceipt = (k: "notice") => { const n = { ...receipts, [k]: true }; setReceipts(n); store.set(`op_desk_rcpt_${contestId}`, n); };

  /** Run one signed action as the acting admin and log what happened. */
  const act = async (label: string, f: () => Promise<{ ok: boolean; data: any; status: number }>) => {
    setBusy(true);
    const r = await f();
    say(`${acting?.name ?? "?"}: ${label} → ${r.ok ? "ok" : errorText(r as any)}`);
    setBusy(false);
    await refresh();
    return r;
  };

  const seed = async () => {
    setBusy(true);
    const r = await call("POST", "/demo/seed");
    setBusy(false);
    if (!r.ok) return say(`seed failed: ${errorText(r)}`);
    saveKit({ admins: r.data.admins, members: r.data.members, contestId: r.data.contestId, voteDate: r.data.voteDate } as DDemoKit);
    setContestId(r.data.contestId); setActing(r.data.admins[0]);
    say(`Seeded 6 demo admins, 8 demo members (PIN 1234) and a contest voting on ${when(r.data.voteDate)}.`);
    await loadDemo(); await reload();
  };
  const advance = async (days: number) => {
    const r = await call("POST", "/demo/advance", { days });
    say(r.ok ? `Clock moved forward ${days} day${days === 1 ? "" : "s"} → now ${when(r.data.now)}` : `advance failed: ${errorText(r)}`);
    await loadDemo(); await refresh();
  };
  const addCustom = () => {
    try {
      const a = JSON.parse(custom) as Identity;
      if (!a.id || !a.privateKey || !a.role) throw new Error();
      const n = [...extra.filter((x) => x.id !== a.id), a]; setExtra(n); store.set("op_desk_extra", n); setCustom(""); setActing(a);
    } catch { say('Could not read that key. Paste JSON like {"id":"…","name":"…","role":"secretary","ward":null,"privateKey":"…"}'); }
  };

  const propose = (action: string) => act(`propose “${ACTION_LABEL[action]}”`, async () => {
    const r = await call("POST", "/admin/approvals", { action, payload: { contestId } }, acting!);
    if (r.ok) saveApprovals([...approvals, { id: r.data.id, action, by: acting!.name, approvedBy: [] }]);
    return r;
  });
  const approve = (a: Approval) => act(`approve “${ACTION_LABEL[a.action]}”`, async () => {
    const r = await call("POST", `/admin/approvals/${a.id}/approve`, undefined, acting!);
    saveApprovals(approvals.map((x) => (x.id === a.id ? { ...x, approvedBy: r.ok || r.data?.error === "already_voted" ? [...new Set([...x.approvedBy, acting!.name])] : x.approvedBy } : x)));
    return r;
  });

  const role = acting?.role;
  const pendingFor = (action: string) => approvals.filter((a) => a.action === action).slice(-1)[0];
  const state = contest?.state ?? "";
  const voteDate = contest ? new Date(contest.vote_date) : null;
  const nowDate = demo ? new Date(demo.now) : new Date();
  const daysToVote = voteDate ? Math.ceil((voteDate.getTime() - nowDate.getTime()) / 86_400_000) : 0;

  const steps = [
    { key: "races", done: races.length > 0 || ["open", "closed"].includes(state) },
    { key: "stamps", done: races.some((r) => r.candidates.some((c) => c.vetted + c.flagged > 0)) },
    { key: "notice", done: !!receipts.notice || ["open", "closed"].includes(state) },
    { key: "freeze", done: !!reg || ["open", "closed"].includes(state) },
    { key: "regrcpt", done: !!reg?.filed || ["open", "closed"].includes(state) },
    { key: "open", done: ["open", "closed"].includes(state) },
    { key: "close", done: state === "closed" },
  ];
  const nowIdx = steps.findIndex((s) => !s.done);
  const cls = (i: number) => (steps[i].done ? "done" : i === nowIdx ? "now" : "");

  const ApprovalsFor = ({ action }: { action: string }) => {
    const w = WHO[action]; const p = pendingFor(action);
    const canPropose = !!acting && w.propose.includes(acting.role);
    const canApprove = !!acting && w.approve.includes(acting.role) && !!p && !p.approvedBy.includes(acting.name) && p.by !== acting.name;
    return (
      <div className="small">
        <div className="muted">Proposed by the {w.propose.map((x) => ROLE_LABEL[x]).join(" / ")}; approved by two of: {w.approve.map((x) => ROLE_LABEL[x]).join(", ")}.</div>
        <div className="row tight" style={{ marginTop: 6 }}>
          <button disabled={busy || !canPropose} onClick={() => propose(action)} title={canPropose ? "" : `Switch to the ${w.propose.map((x) => ROLE_LABEL[x]).join(" or ")}`}>Propose as {acting ? ROLE_LABEL[acting.role] : "…"}</button>
          {p && <span>Latest proposal by {p.by}; approved by: {p.approvedBy.length ? p.approvedBy.join(", ") : "nobody yet"}</span>}
          {p && <button className="secondary" disabled={busy || !canApprove} onClick={() => approve(p)}>Approve as {acting ? ROLE_LABEL[acting.role] : "…"}</button>}
        </div>
      </div>
    );
  };

  return (
    <>
      <h1>Admin desk</h1>
      <p className="lead">Set up a contest, vet candidates and run the gates. Every action is signed with the acting admin&apos;s own key, and anything important needs several different people.</p>

      {demo === null && <div className="banner">Demo mode is <strong>off</strong> on this platform. Sign in below with real admin keys. (To try the screens locally, start the platform with <code>DEMO_MODE=1</code>.)</div>}
      {demo && (
        <div className="banner demo">
          <strong>Demo mode.</strong> Platform clock: {when(demo.now)} (+{demo.offsetDays} days). Seeds fake admins and members into this database; never use with real members.
          <div className="row tight" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={seed}>{kit ? "Seed a new demo contest" : "Seed demo admins, members and contest"}</button>
            <span className="muted small">Move the clock:</span>
            {[1, 7, 30].map((d) => <button key={d} className="secondary" onClick={() => advance(d)}>+{d} day{d > 1 ? "s" : ""}</button>)}
            {contest && daysToVote > 0 && <button className="secondary" onClick={() => advance(daysToVote)}>Jump to the vote date (+{daysToVote})</button>}
            {kit && <button className="secondary" onClick={() => { saveKit(null); setActing(null); }}>Forget demo keys</button>}
          </div>
        </div>
      )}
      {err && <div className="msg err">{err}. Is the platform running?</div>}

      <h2>Acting as</h2>
      {!identities.length && <p className="muted">No admin keys loaded. {demo ? "Seed the demo above, or paste a key below." : "Paste an admin key below."}</p>}
      <div className="who" role="group" aria-label="Acting as">
        {identities.map((a) => <button key={a.id} className={acting?.id === a.id ? "on" : ""} onClick={() => setActing(a)}>{ROLE_LABEL[a.role] ?? a.role}</button>)}
      </div>
      <details><summary className="small muted">Use another admin key</summary>
        <textarea rows={3} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder='{"id":"…","name":"…","role":"secretary","ward":null,"privateKey":"…"}' />
        <button className="secondary" onClick={addCustom} disabled={!custom}>Add key</button>
      </details>

      <h2>Contest</h2>
      <select aria-label="Contest" value={contestId} onChange={(e) => setContestId(e.target.value)}>
        {rows?.map((c) => <option key={c.id} value={c.id}>{c.name}: {stateLabel[c.state] ?? c.state}, vote on {when(c.vote_date)}</option>)}
      </select>
      {contest && <p className="muted small">Status: <strong>{stateLabel[contest.state] ?? contest.state}</strong>{voteDate ? ` · vote date ${when(contest.vote_date)} (${daysToVote > 0 ? `in ${daysToVote} days` : daysToVote === 0 ? "today" : `${-daysToVote} days ago`})` : ""}</p>}
      {!rows?.length && <p className="muted">No contests yet. {demo ? "Seed the demo to get one." : "Create one with POST /admin/contests."}</p>}

      {contest && acting && (
        <ol className="steps">
          <li className={cls(0)}>
            <h4>Put the offices on the ballot</h4>
            <div className="small muted">Secretary or electoral committee. A form fee is optional; candidates buy the form to be listed.</div>
            {races.map((r) => <div key={r.id} className="small">• {r.office} ({r.scope}) · fee {money(r.formFeeMinor)} · {r.candidates.length} candidate{r.candidates.length === 1 ? "" : "s"}</div>)}
            {["draft", "noticed"].includes(state) && (
              <div className="grid2" style={{ marginTop: 6 }}>
                <div><label htmlFor="of">Office</label><input id="of" value={form.office} onChange={(e) => setForm({ ...form, office: e.target.value })} /></div>
                <div><label htmlFor="sc">Scope</label><input id="sc" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} /></div>
                <div><label htmlFor="fe">Form fee (₦, 0 = free)</label><input id="fe" inputMode="numeric" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value.replace(/\D/g, "") })} /></div>
                <div style={{ alignSelf: "end" }}><button disabled={busy || !["secretary", "electoral_committee"].includes(role!)} onClick={() => act(`add office “${form.office}”`, () => call("POST", "/admin/races", { contestId, office: form.office, scope: form.scope, formFeeMinor: Number(form.fee || 0) * 100 }, acting))}>Add office</button></div>
              </div>
            )}
          </li>

          <li className={cls(1)}>
            <h4>Vet candidates (optional stamps)</h4>
            <div className="small muted">Any admin can stamp a candidate vetted or flagged. A stamp informs voters; it never removes a candidate.</div>
            {races.flatMap((r) => r.candidates.map((c) => (
              <div key={c.id} className="row tight small" style={{ margin: "6px 0" }}>
                <strong style={{ minWidth: 160 }}>{c.name}</strong><span className="muted">{r.office}</span>
                <span className={`pill ${c.state === "listed" ? "vetted" : "mixed"}`}>{c.state === "listed" ? "listed" : "unpaid"}</span>
                <span className={`pill ${c.status}`}>{c.status} ({c.vetted}/{c.flagged})</span>
                <button className="secondary" disabled={busy} onClick={() => act(`stamp ${c.name} vetted`, () => call("POST", `/admin/candidates/${c.id}/stamp`, { verdict: "vetted" }, acting))}>Vetted</button>
                <button className="secondary" disabled={busy} onClick={() => act(`stamp ${c.name} flagged`, () => call("POST", `/admin/candidates/${c.id}/stamp`, { verdict: "flagged", note: "Flagged from the admin desk" }, acting))}>Flag</button>
              </div>
            )))}
            {!races.some((r) => r.candidates.length) && <div className="small muted">No candidates yet. Members can register on <a href="/election/apply">Stand for office</a>.</div>}
          </li>

          <li className={cls(2)}>
            <h4>Record INEC&apos;s receipt for the notice</h4>
            <div className="small muted">Secretary or electoral committee. The reference is 6 to 64 letters, digits or . _ / -</div>
            <div className="row tight">
              <input style={{ maxWidth: 260 }} aria-label="Notice receipt" value={noticeReceipt} onChange={(e) => setNoticeReceipt(e.target.value)} />
              <button disabled={busy || !["secretary", "electoral_committee"].includes(role!) || state !== "noticed" || !!receipts.notice} onClick={async () => { const r = await act("record notice receipt", () => call("POST", `/admin/contests/${contestId}/notice-receipt`, { receipt: noticeReceipt }, acting)); if (r.ok || r.data?.error === "already_set") markReceipt("notice"); }}>Record</button>
              {state === "draft" && <span className="muted small">The notice must be issued first (needs 21 days before the vote).</span>}
            </div>
          </li>

          <li className={cls(3)}>
            <h4>Freeze the register</h4>
            <div className="small muted">Snapshot of the active members who may vote. Must be at least 21 days before the vote date.</div>
            {reg && <div className="small">Frozen: {reg.member_count} members on the register.</div>}
            {!reg && state === "noticed" && <ApprovalsFor action="register.freeze" />}
          </li>

          <li className={cls(4)}>
            <h4>Record INEC&apos;s receipt for the register</h4>
            <div className="row tight">
              <input style={{ maxWidth: 260 }} aria-label="Register receipt" value={regReceipt} onChange={(e) => setRegReceipt(e.target.value)} />
              <button disabled={busy || !reg || reg.filed || !["secretary", "electoral_committee"].includes(role!)} onClick={() => act("record register receipt", () => call("POST", `/admin/registers/${reg!.id}/receipt`, { receipt: regReceipt }, acting))}>Record</button>
              {reg?.filed && <span className="small">Recorded.</span>}
            </div>
          </li>

          <li className={cls(5)}>
            <h4>Open voting</h4>
            <div className="small muted">Only on or after the vote date{daysToVote > 0 ? ` (${daysToVote} days away${demo ? ": move the clock" : ""})` : ""}, and only with the notice, the register and both receipts in place.</div>
            {state === "noticed" && <ApprovalsFor action="contest.open" />}
            {state === "open" && <div className="small ok">Voting is open. Members can vote online, by USSD (option 5) or at a <a href="/election/unit">polling unit</a>.</div>}
          </li>

          <li className={cls(6)}>
            <h4>Close voting and publish results</h4>
            <div className="small muted">Results are hidden while voting is open and published, with turnout, when it closes.</div>
            {state === "open" && <ApprovalsFor action="contest.close" />}
            {state === "closed" && <div className="small"><a href="/election">See the results</a></div>}
          </li>
        </ol>
      )}

      <h2>What happened</h2>
      <pre className="log" aria-live="polite">{log.length ? log.join("\n") : "Actions you take appear here."}</pre>
    </>
  );
}

type DDemoKit = import("../lib").DemoKit;
