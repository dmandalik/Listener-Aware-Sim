"use client";

import { useCallback, useEffect, useState } from "react";

type Summary = {
  sessions: { total: number; byStatus: Record<string, number>; byAssignment: Record<string, number> };
  cells: Array<{ taskId: string; assignment: string; trials: number; completed: number; successRate: number | null; medianDurationMs: number | null; medianCost: number | null }>;
  dropout: { abandoned: number; byTrialsCompleted: Record<string, number> };
  pool: { utterances: number; totalServed: number; avgSuccessRate: number | null };
};
type SessionRow = { id: string; pid: string; role: string; assignment: string | null; status: string; startedAt: string; endedAt: string | null; trials: number };

const TABLES = ["events", "trials", "sessions", "participants", "utterances"] as const;

function pct(x: number | null) { return x == null ? "—" : `${Math.round(x * 100)}%`; }
function ms(x: number | null) { return x == null ? "—" : `${(x / 1000).toFixed(1)}s`; }

export default function AdminPage() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"dashboard" | "sessions">("dashboard");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [step, setStep] = useState(0);

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
    setSessions(await api("/api/admin/sessions", k));
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
        <button className={tab === "sessions" ? "on" : ""} onClick={() => setTab("sessions")}>Sessions &amp; replay</button>
      </div>

      {tab === "dashboard" && (
        <div className="stack" style={{ gap: 22 }}>
          <div className="statrow">
            <div className="box"><b>{s.sessions.total}</b><span>sessions</span></div>
            <div className="box"><b>{s.sessions.byStatus.completed ?? 0}</b><span>completed</span></div>
            <div className="box"><b>{s.dropout.abandoned}</b><span>abandoned</span></div>
            <div className="box"><b>{s.sessions.byAssignment.speaker ?? 0}</b><span>speakers</span></div>
            <div className="box"><b>{s.sessions.byAssignment.novice ?? 0}</b><span>novices</span></div>
            <div className="box"><b>{s.sessions.byAssignment.expert ?? 0}</b><span>experts</span></div>
            <div className="box"><b>{s.pool.utterances}</b><span>utterances</span></div>
          </div>

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
