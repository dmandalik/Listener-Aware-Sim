"use client";

import { useCallback, useEffect, useState } from "react";

type Summary = {
  sessions: { total: number; completed: number; inProgress: number; byAssignment: Record<string, number> };
  cells: Array<{ taskId: string; assignment: string; trials: number; completed: number; successRate: number | null; medianDurationMs: number | null; medianCost: number | null }>;
  dropout: { abandoned: number };
  pool: { utterances: number; totalServed: number; avgSuccessRate: number | null };
};
type RoleStat = { n: number; successRate: number | null; medianMoves: number | null; medianDurationMs: number | null };
type Analysis = {
  participants: { novice: number; expert: number; speaker: number };
  overall: { novice: RoleStat; expert: RoleStat; successGap: number | null };
  byTask: Array<{ taskId: string; novice: RoleStat; expert: RoleStat; successGap: number | null }>;
  withinUtterance: { paired: number; expertBetter: number; noviceBetter: number; same: number; expertAdvantage: number | null };
  workload: { novice: number | null; expert: number | null; byTask: Array<{ taskId: string; novice: number | null; expert: number | null }> };
  generatedAt: string | null;
};
type SessionRow = { id: string; pid: string; role: string; assignment: string | null; status: string; startedAt: string; endedAt: string | null; trials: number };

const TABLES = [
  "dataset", "results", "authored", "tlx", "survey", "roster",
  "events", "trials", "sessions", "participants", "utterances", "trialSurveys",
] as const;

function pct(x: number | null) { return x == null ? "—" : `${Math.round(x * 100)}%`; }
function ms(x: number | null) { return x == null ? "—" : `${(x / 1000).toFixed(1)}s`; }

const preStyle: React.CSSProperties = {
  margin: 0, padding: "10px 12px", background: "var(--paper, #faf7ef)", border: "1px solid var(--line)",
  borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5,
  overflowX: "auto", maxHeight: 340, whiteSpace: "pre",
};

export default function AdminPage() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"dashboard" | "analysis" | "sessions" | "pddl">("dashboard");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [step, setStep] = useState(0);
  // PDDL models (built live from the DB).
  const [pddl, setPddl] = useState<any[] | null>(null);
  const [pddlSel, setPddlSel] = useState<any | null>(null);

  const api = useCallback(
    async (path: string, k = key) => {
      const res = await fetch(path, { headers: { "x-admin-key": k } });
      if (res.status === 401) throw new Error("unauthorized");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "error");
      return j;
    },
    [key],
  );

  const download = useCallback(
    async (path: string, filename: string) => {
      const res = await fetch(path, { headers: { "x-admin-key": key } });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    [key],
  );

  const loadAll = useCallback(async (k: string) => {
    const s = await api("/api/admin/summary", k);
    setSummary(s);
    setAnalysis(await api("/api/admin/analysis", k));
    setSessions(await api("/api/admin/sessions", k));
  }, [api]);

  // Refresh the live numbers (dashboard + analysis) on demand.
  const refresh = useCallback(async () => {
    try {
      setSummary(await api("/api/admin/summary"));
      setAnalysis(await api("/api/admin/analysis"));
    } catch { /* keep last */ }
  }, [api]);

  useEffect(() => {
    const saved = sessionStorage.getItem("adminKey");
    if (saved) {
      setKey(saved);
      loadAll(saved).then(() => setAuthed(true)).catch(() => sessionStorage.removeItem("adminKey"));
    }
  }, [loadAll]);

  const submit = async () => {
    setErr(null);
    try {
      await loadAll(key);
      sessionStorage.setItem("adminKey", key);
      setAuthed(true);
    } catch {
      setErr("Wrong secret.");
    }
  };

  const openSession = async (sid: string) => {
    setDetail(await api(`/api/admin/sessions?sid=${encodeURIComponent(sid)}`));
    setStep(0);
  };

  const loadPddl = useCallback(async () => {
    setTab("pddl"); setPddlSel(null);
    try { setPddl((await api("/api/admin/pddl")).models); } catch { setPddl([]); }
  }, [api]);
  const viewPddl = async (k: string) => {
    setPddlSel({ key: k, loading: true });
    try { setPddlSel({ key: k, ...(await api(`/api/admin/pddl?one=${encodeURIComponent(k)}`)) }); }
    catch (e) { setPddlSel({ key: k, error: (e as Error).message }); }
  };

  if (!authed) {
    return (
      <main className="center-screen">
        <div className="card" style={{ padding: 28, width: "min(420px, 92vw)" }}>
          <div className="eyebrow">Admin</div>
          <h2 style={{ margin: "4px 0 14px" }}>Enter the admin secret</h2>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="ADMIN_SECRET"
            style={{ width: "100%", padding: "11px 13px", borderRadius: 8, border: "1px solid var(--line)", fontFamily: "var(--font-mono)" }}
          />
          {err && <p style={{ color: "var(--alert)", fontSize: 14, marginTop: 8 }}>{err}</p>}
          <button className="btn" style={{ marginTop: 14, width: "100%" }} onClick={submit}>Unlock</button>
        </div>
      </main>
    );
  }

  const s = summary!;
  return (
    <div className="admin-wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="eyebrow">Listener Aware Simulation</div>
          <h1>Admin &amp; data</h1>
        </div>
        <button className="pill-btn" onClick={() => { sessionStorage.removeItem("adminKey"); setAuthed(false); }}>Lock</button>
      </div>

      <div className="tabs">
        <button className={tab === "dashboard" ? "on" : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
        <button className={tab === "analysis" ? "on" : ""} onClick={() => { setTab("analysis"); refresh(); }}>Analysis</button>
        <button className={tab === "sessions" ? "on" : ""} onClick={() => setTab("sessions")}>Sessions &amp; replay</button>
        <button className={tab === "pddl" ? "on" : ""} onClick={loadPddl}>PDDL models</button>
      </div>

      {tab === "dashboard" && (
        <div className="stack" style={{ gap: 22 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -12 }}>
            <button className="pill-btn" onClick={refresh}>Refresh</button>
          </div>
          <div className="statrow">
            <div className="box"><b>{s.sessions.completed}</b><span>completed</span></div>
            <div className="box"><b>{s.sessions.inProgress}</b><span>in progress</span></div>
            <div className="box"><b>{s.sessions.byAssignment.speaker ?? 0}</b><span>speakers</span></div>
            <div className="box"><b>{s.sessions.byAssignment.novice ?? 0}</b><span>novices</span></div>
            <div className="box"><b>{s.sessions.byAssignment.expert ?? 0}</b><span>experts</span></div>
            <div className="box"><b>{s.pool.utterances}</b><span>utterances</span></div>
          </div>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "-8px 0 0" }}>
            Speaker / novice / expert counts are <b>completed, real participants only</b> — test-name and
            unfinished runs are excluded.
          </p>

          <div className="card" style={{ padding: 16, overflowX: "auto" }}>
            <h4 style={{ margin: "0 0 10px", color: "var(--ink-soft)" }}>Condition cells (task × role)</h4>
            <table className="admin-table">
              <thead><tr><th>Task</th><th>Role</th><th>Trials</th><th>Completed</th><th>Success</th><th>Median time</th><th>Median moves</th></tr></thead>
              <tbody>
                {s.cells.map((c) => (
                  <tr key={`${c.taskId}-${c.assignment}`}>
                    <td>{c.taskId}</td><td>{c.assignment}</td><td>{c.trials}</td><td>{c.completed}</td>
                    <td>{pct(c.successRate)}</td><td>{ms(c.medianDurationMs)}</td><td>{c.medianCost ?? "—"}</td>
                  </tr>
                ))}
                {s.cells.length === 0 && <tr><td colSpan={7} style={{ color: "var(--ink-soft)" }}>No trials yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <h4 style={{ margin: "0 0 10px", color: "var(--ink-soft)" }}>Export (works while the study is running)</h4>
            <div style={{ display: "grid", gap: 8 }}>
              {TABLES.map((t) => (
                <div key={t} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 110, fontWeight: 600 }}>{t}</span>
                  <button className="pill-btn" onClick={() => download(`/api/admin/export?table=${t}&format=csv`, `${t}.csv`)}>CSV</button>
                  <button className="pill-btn" onClick={() => download(`/api/admin/export?table=${t}&format=jsonl`, `${t}.jsonl`)}>JSONL</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "pddl" && (
        <div className="stack" style={{ gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: 0, maxWidth: 640 }}>
              One PDDL model per completed, non-test trial, built live from the database. Each is a task
              <b> domain</b> + a <b>problem</b> (the scenario) + a <b>profile</b> (role, novice/expert, message,
              moves vs optimal, skill). Click a row to view it.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="pill-btn" onClick={loadPddl}>Refresh</button>
              <button className="pill-btn" onClick={() => download("/api/admin/pddl?download=1", "pddl_models.jsonl")}>Download all (JSONL)</button>
            </div>
          </div>

          {!pddl ? (
            <p style={{ color: "var(--ink-soft)" }}>Building models…</p>
          ) : pddl.length === 0 ? (
            <p style={{ color: "var(--ink-soft)" }}>No completed trials yet.</p>
          ) : (
            <div className="card" style={{ padding: 16, overflowX: "auto" }}>
              <table className="admin-table">
                <thead><tr><th>Task</th><th>Participant</th><th>Role</th><th>Success</th><th>Moves</th><th>Optimal</th><th>Skill</th><th></th></tr></thead>
                <tbody>
                  {pddl.map((m) => (
                    <tr key={m.key} style={{ background: pddlSel?.key === m.key ? "var(--accent-wash)" : undefined }}>
                      <td>{m.task}</td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{m.participant}</td>
                      <td>{m.role}</td>
                      <td>{m.success == null ? "—" : m.success ? "✓" : "✗"}</td>
                      <td>{m.moves ?? "—"}</td>
                      <td>{m.optimalMoves ?? "—"}</td>
                      <td>{m.skill == null ? "—" : m.skill.toFixed(2)}</td>
                      <td><button className="pill-btn" onClick={() => viewPddl(m.key)}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pddlSel && (
            <div className="card" style={{ padding: 16 }}>
              {pddlSel.loading ? (
                <p style={{ color: "var(--ink-soft)" }}>Loading…</p>
              ) : pddlSel.error ? (
                <p style={{ color: "var(--alert)" }}>{pddlSel.error}</p>
              ) : (
                <div className="stack" style={{ gap: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <h4 style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13 }}>{pddlSel.key}</h4>
                    <button className="pill-btn" onClick={() => setPddlSel(null)}>Close</button>
                  </div>
                  <div>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>profile.json</div>
                    <pre style={preStyle}>{JSON.stringify(pddlSel.profile, null, 2)}</pre>
                  </div>
                  <div>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>problem.pddl</div>
                    <pre style={preStyle}>{pddlSel.problem}</pre>
                  </div>
                  <div>
                    <div className="eyebrow" style={{ marginBottom: 6 }}>domain: {pddlSel.profile?.task}.pddl</div>
                    <pre style={preStyle}>{pddlSel.domain}</pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "analysis" && (
        <div className="stack" style={{ gap: 22 }}>
          {!analysis ? (
            <p style={{ color: "var(--ink-soft)" }}>Loading analysis…</p>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: 0 }}>
                  Live — completed, real participants only. {analysis.generatedAt ? `Updated ${new Date(analysis.generatedAt).toLocaleTimeString()}.` : ""} Re-open the tab or hit Refresh to recompute.
                </p>
                <button className="pill-btn" onClick={refresh}>Refresh</button>
              </div>

              <div className="statrow">
                <div className="box"><b>{analysis.participants.novice}</b><span>novices</span></div>
                <div className="box"><b>{analysis.participants.expert}</b><span>experts</span></div>
                <div className="box">
                  <b>{analysis.overall.successGap == null ? "—" : `${analysis.overall.successGap > 0 ? "+" : ""}${Math.round(analysis.overall.successGap * 100)}pp`}</b>
                  <span>expert − novice success</span>
                </div>
              </div>

              <div className="card" style={{ padding: 16, overflowX: "auto" }}>
                <h4 style={{ margin: "0 0 4px", color: "var(--ink-soft)" }}>Novice vs Expert (success, effort)</h4>
                <p style={{ color: "var(--ink-soft)", fontSize: 12, margin: "0 0 10px" }}>
                  Gap = expert success − novice success (positive means the manipulation is separating them).
                </p>
                <table className="admin-table">
                  <thead><tr><th>Task</th><th>Novice n</th><th>Novice succ.</th><th>Nov. moves</th><th>Expert n</th><th>Expert succ.</th><th>Exp. moves</th><th>Gap</th></tr></thead>
                  <tbody>
                    <tr style={{ fontWeight: 700 }}>
                      <td>ALL</td>
                      <td>{analysis.overall.novice.n}</td><td>{pct(analysis.overall.novice.successRate)}</td><td>{analysis.overall.novice.medianMoves ?? "—"}</td>
                      <td>{analysis.overall.expert.n}</td><td>{pct(analysis.overall.expert.successRate)}</td><td>{analysis.overall.expert.medianMoves ?? "—"}</td>
                      <td>{analysis.overall.successGap == null ? "—" : `${analysis.overall.successGap > 0 ? "+" : ""}${Math.round(analysis.overall.successGap * 100)}pp`}</td>
                    </tr>
                    {analysis.byTask.map((r) => (
                      <tr key={r.taskId}>
                        <td>{r.taskId}</td>
                        <td>{r.novice.n}</td><td>{pct(r.novice.successRate)}</td><td>{r.novice.medianMoves ?? "—"}</td>
                        <td>{r.expert.n}</td><td>{pct(r.expert.successRate)}</td><td>{r.expert.medianMoves ?? "—"}</td>
                        <td>{r.successGap == null ? "—" : `${r.successGap > 0 ? "+" : ""}${Math.round(r.successGap * 100)}pp`}</td>
                      </tr>
                    ))}
                    {analysis.overall.novice.n === 0 && analysis.overall.expert.n === 0 && (
                      <tr><td colSpan={8} style={{ color: "var(--ink-soft)" }}>No completed listener trials yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="card" style={{ padding: 16 }}>
                <h4 style={{ margin: "0 0 4px", color: "var(--ink-soft)" }}>Within-utterance contrast</h4>
                <p style={{ color: "var(--ink-soft)", fontSize: 12, margin: "0 0 10px" }}>
                  Of utterances heard by both a novice and an expert, how the two outcomes compared. Expert-advantage = the share where the expert succeeded and the novice didn't.
                </p>
                <div className="statrow">
                  <div className="box"><b>{analysis.withinUtterance.paired}</b><span>paired utterances</span></div>
                  <div className="box"><b>{analysis.withinUtterance.expertBetter}</b><span>expert &gt; novice</span></div>
                  <div className="box"><b>{analysis.withinUtterance.noviceBetter}</b><span>novice &gt; expert</span></div>
                  <div className="box"><b>{analysis.withinUtterance.same}</b><span>same outcome</span></div>
                  <div className="box"><b>{pct(analysis.withinUtterance.expertAdvantage)}</b><span>expert-advantage</span></div>
                </div>
              </div>

              <div className="card" style={{ padding: 16, overflowX: "auto" }}>
                <h4 style={{ margin: "0 0 4px", color: "var(--ink-soft)" }}>Perceived workload (NASA-TLX, 0–100; higher = harder)</h4>
                <p style={{ color: "var(--ink-soft)", fontSize: 12, margin: "0 0 10px" }}>
                  Mean of each trial's six-item average, by role. Rises when utterances leave the listener working harder.
                </p>
                <table className="admin-table">
                  <thead><tr><th>Task</th><th>Novice TLX</th><th>Expert TLX</th></tr></thead>
                  <tbody>
                    <tr style={{ fontWeight: 700 }}>
                      <td>ALL</td><td>{analysis.workload.novice ?? "—"}</td><td>{analysis.workload.expert ?? "—"}</td>
                    </tr>
                    {analysis.workload.byTask.map((r) => (
                      <tr key={r.taskId}><td>{r.taskId}</td><td>{r.novice ?? "—"}</td><td>{r.expert ?? "—"}</td></tr>
                    ))}
                    {analysis.workload.novice == null && analysis.workload.expert == null && (
                      <tr><td colSpan={3} style={{ color: "var(--ink-soft)" }}>No TLX responses yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "sessions" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)", gap: 18, alignItems: "start" }}>
          <div className="card" style={{ padding: 12, overflowX: "auto", maxHeight: "70vh", overflowY: "auto" }}>
            <table className="admin-table">
              <thead><tr><th>PID</th><th>Role</th><th>Status</th><th>Trials</th></tr></thead>
              <tbody>
                {(sessions ?? []).map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => openSession(r.id)}>
                    <td>{r.pid}</td><td>{r.assignment ?? r.role}</td><td>{r.status}</td><td>{r.trials}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 16 }}>
            {!detail ? (
              <p style={{ color: "var(--ink-soft)" }}>Select a session to replay it event-by-event.</p>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                <div style={{ fontSize: 13 }}>
                  <b>{detail.session.pid}</b> · {detail.session.assignment ?? detail.session.role} · {detail.session.status}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="admin-table">
                    <thead><tr><th>#</th><th>Task</th><th>Utterance</th><th>✓</th><th>Moves</th><th>Time</th></tr></thead>
                    <tbody>
                      {detail.trials.map((t: any) => (
                        <tr key={t.trialIndex}>
                          <td>{t.trialIndex}</td><td>{t.taskId}</td>
                          <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={t.utteranceText ?? ""}>{t.utteranceText ?? "—"}</td>
                          <td>{t.correct == null ? "—" : t.correct ? "✓" : "✗"}</td><td>{t.cost ?? "—"}</td><td>{ms(t.durationMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                  <button className="pill-btn" onClick={() => setStep((i) => Math.max(0, i - 1))}>‹ Prev</button>
                  <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                    event {detail.timeline.length ? step + 1 : 0} / {detail.timeline.length}
                  </span>
                  <button className="pill-btn" onClick={() => setStep((i) => Math.min(detail.timeline.length - 1, i + 1))}>Next ›</button>
                </div>
                {detail.timeline[step] && (
                  <pre className="evt" style={{ background: "var(--paper-2)", padding: 12, borderRadius: 8, overflowX: "auto", margin: 0 }}>
{JSON.stringify(detail.timeline[step].payload, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
