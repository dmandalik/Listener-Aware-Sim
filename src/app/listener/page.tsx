"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrialPayload, ViewAs } from "@/lib/server/listener";
import { GameBoard, type RetrievalListenerWorld } from "@/components/GameBoard";
import { RobotAvatar, type RobotMood } from "@/components/RobotAvatar";
import { SpeakerPanel } from "@/components/SpeakerPanel";

type Phase = "loading" | "playing" | "trialEnd" | "done" | "error";

async function post(url: string, body: unknown): Promise<TrialPayload> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "request failed");
  return json as TrialPayload;
}

export default function ListenerPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [payload, setPayload] = useState<TrialPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budgetTotal, setBudgetTotal] = useState(1);
  const [timeLeft, setTimeLeft] = useState(0);
  // Dev-only representation toggle (?dev=1). viewAs=null → the assigned condition.
  const [dev, setDev] = useState(false);
  const [viewAs, setViewAs] = useState<ViewAs | null>(null);
  const viewAsRef = useRef<ViewAs | null>(null);
  viewAsRef.current = viewAs;
  const busy = useRef(false);

  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
  }, []);

  const beginTrial = useCallback(async (p: TrialPayload) => {
    setBudgetTotal(p.view?.budgetLeft || 1);
    setTimeLeft(Math.round((p.timeoutMs || 0) / 1000));
    setPhase(p.terminal ? "trialEnd" : "playing");
    // Apply the current dev override (if any) to the freshly-opened trial.
    if (viewAsRef.current) {
      try {
        const o = await post("/api/listener/view", {
          sessionId: p.sessionId,
          trialIndex: p.trialIndex,
          viewAs: viewAsRef.current,
        });
        setPayload(o);
        return;
      } catch {
        /* fall through to the un-overridden view */
      }
    }
    setPayload(p);
  }, []);

  // Start (or resume) the session on mount.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const sid = qs.get("sid");
    // Routed from /play with an assigned session → resume it (keeps the locked
    // novice/expert assignment). Direct /listener access → start a dev session.
    const req = sid
      ? post("/api/listener/resume", { sessionId: sid })
      : post("/api/listener/start", {
          studyName: "listener_pilot",
          prolific: {
            pid: qs.get("PROLIFIC_PID") ?? undefined,
            studyId: qs.get("STUDY_ID") ?? undefined,
            sessionId: qs.get("SESSION_ID") ?? undefined,
          },
        });
    req.then(beginTrial).catch((e) => {
      setError(e.message);
      setPhase("error");
    });
  }, [beginTrial]);

  const send = useCallback(
    async (action: unknown) => {
      if (!payload || busy.current || payload.terminal) return;
      busy.current = true;
      try {
        const p = await post("/api/listener/action", {
          sessionId: payload.sessionId,
          trialIndex: payload.trialIndex,
          action,
          viewAs: viewAsRef.current ?? undefined,
        });
        setPayload(p);
        if (p.terminal) setPhase("trialEnd");
      } catch (e) {
        setError((e as Error).message);
        setPhase("error");
      } finally {
        busy.current = false;
      }
    },
    [payload],
  );

  const move = useCallback((dir: string) => send({ type: "move", dir }), [send]);
  const pick = useCallback((objectId: string) => send({ type: "pick", objectId }), [send]);

  // Keyboard control. Disabled in the Speaker view (the speaker cannot act).
  useEffect(() => {
    if (phase !== "playing" || viewAs === "speaker") return;
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, string> = {
        ArrowUp: "up", w: "up", W: "up",
        ArrowDown: "down", s: "down", S: "down",
        ArrowLeft: "left", a: "left", A: "left",
        ArrowRight: "right", d: "right", D: "right",
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        void move(dir);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, move, viewAs]);

  // Timeout countdown. Paused in the Speaker view (no trial clock while composing).
  useEffect(() => {
    if (phase !== "playing" || !payload || viewAs === "speaker") return;
    if (timeLeft <= 0) {
      void post("/api/listener/timeout", {
        sessionId: payload.sessionId,
        trialIndex: payload.trialIndex,
      })
        .then((p) => {
          setPayload(p);
          setPhase("trialEnd");
        })
        .catch(() => {});
      return;
    }
    const id = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, timeLeft, payload, viewAs]);

  // Dev toggle: re-render the current trial under a chosen representation.
  const chooseView = useCallback(
    async (as: ViewAs | null) => {
      setViewAs(as);
      viewAsRef.current = as;
      if (!payload) return;
      try {
        const o = await post("/api/listener/view", {
          sessionId: payload.sessionId,
          trialIndex: payload.trialIndex,
          viewAs: as ?? undefined,
        });
        setPayload(o);
      } catch {
        /* ignore */
      }
    },
    [payload],
  );

  // Speaker: save the composed utterance to the pool.
  const saveUtterance = useCallback(
    async (text: string, composeMs: number) => {
      if (!payload) return;
      await fetch("/api/listener/utterance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: payload.sessionId,
          trialIndex: payload.trialIndex,
          text,
          composeMs,
        }),
      });
    },
    [payload],
  );

  const goNext = useCallback(async () => {
    if (!payload) return;
    try {
      const p = await post("/api/listener/next", { sessionId: payload.sessionId });
      if (p.done) {
        setPhase("done");
      } else {
        beginTrial(p);
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }, [payload, beginTrial]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (phase === "loading") {
    return (
      <main className="center-screen">
        <div className="stack" style={{ alignItems: "center", gap: 14 }}>
          <RobotAvatar mood="waiting" size={72} />
          <p style={{ color: "var(--ink-soft)" }}>Booting the robot…</p>
        </div>
      </main>
    );
  }

  if (phase === "error") {
    return (
      <main className="center-screen">
        <div className="card" style={{ padding: 28, maxWidth: 460 }}>
          <div className="eyebrow" style={{ color: "var(--alert)" }}>Something went wrong</div>
          <p style={{ marginTop: 8 }}>{error}</p>
        </div>
      </main>
    );
  }

  if (phase === "done") {
    return (
      <main className="center-screen">
        <div className="card" style={{ padding: 36, maxWidth: 480, textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", marginBottom: 8 }}>
            <RobotAvatar mood="thanking" size={92} />
          </div>
          <h1 style={{ margin: "6px 0 8px" }}>All missions complete!</h1>
          <p style={{ color: "var(--ink-soft)" }}>
            Thank you — your data has been recorded. You may now return to Prolific.
          </p>
        </div>
      </main>
    );
  }

  if (!payload || !payload.view) return null;
  const world = payload.view.world as unknown as RetrievalListenerWorld;
  const partsKey = payload.view.keys.find((k) => k.id === "parts");
  const budgetLeft = payload.view.budgetLeft;
  const budgetPct = Math.max(0, Math.round((budgetLeft / budgetTotal) * 100));
  const low = budgetLeft <= Math.max(3, budgetTotal * 0.2);
  const mm = String(Math.floor(timeLeft / 60)).padStart(1, "0");
  const ss = String(timeLeft % 60).padStart(2, "0");

  const endMood: RobotMood =
    payload.outcome == null ? "hopeful" : payload.outcome.correct ? "thanking" : "sad";

  const isSpeaker = viewAs === "speaker" && !!payload.speaker;

  return (
    <div className="game">
      <div className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <RobotAvatar mood={phase === "playing" ? "waiting" : endMood} size={44} />
          <div>
            <div className="eyebrow">Mission {payload.missionNumber} of {payload.missionTotal}</div>
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>Retrieve what the robot needs</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {dev && (
            <div className="dev-toggle" title="Testing only — disabled in production">
              <span className="tag">view</span>
              <button className={viewAs === null ? "on" : ""} onClick={() => chooseView(null)}>
                Assigned
              </button>
              <button className={viewAs === "novice" ? "on" : ""} onClick={() => chooseView("novice")}>
                Novice
              </button>
              <button className={viewAs === "expert" ? "on" : ""} onClick={() => chooseView("expert")}>
                Expert
              </button>
              <button className={viewAs === "speaker" ? "on" : ""} onClick={() => chooseView("speaker")}>
                Speaker
              </button>
            </div>
          )}
          {!isSpeaker && (
            <div className={`timer ${timeLeft <= 30 ? "low" : ""}`} style={{ fontVariantNumeric: "tabular-nums", fontSize: 15 }}>
              ⏱ {mm}:{ss}
            </div>
          )}
          <div className="progress-dots">
            {Array.from({ length: payload.missionTotal }).map((_, i) => (
              <span
                key={i}
                className={`dot ${i < payload.trialIndex ? "done" : i === payload.trialIndex ? "active" : ""}`}
              />
            ))}
          </div>
        </div>
      </div>

      {isSpeaker ? (
        <SpeakerPanel key={payload.trialIndex} data={payload.speaker!} onSave={saveUtterance} />
      ) : (
      <div className="stack" style={{ gap: 16 }}>
        <div className="utterance">
          <RobotAvatar mood="hopeful" size={44} />
          <div className="quote">&ldquo;{payload.utterance}&rdquo;</div>
        </div>

        <div className="play-area">
          <div className="board-wrap">
            <GameBoard world={world} onPick={pick} disabled={phase !== "playing"} />
            <p className="hint">
              Move with <kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> (or <kbd>WASD</kbd>).
              Click an item to pick it up — you get <b>one</b> pick, so choose well.
            </p>
          </div>

          <div className="side">
            <div className="card budget">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
                  Moves left
                </span>
                <b style={{ fontVariantNumeric: "tabular-nums" }}>{budgetLeft}</b>
              </div>
              <div className="meter">
                <div className={`fill ${low ? "low" : ""}`} style={{ width: `${budgetPct}%` }} />
              </div>
              <div className="nums">
                <span>each move costs 1</span>
                <span>{budgetTotal} total</span>
              </div>
            </div>

            {/* Parts key — rendered ONLY when the listener has it. When absent it
                is not shown at all (§11 guardrail: absent, not greyed). */}
            {partsKey?.entries && (
              <div className="card legend">
                <h4>Robot Parts</h4>
                {Object.entries(partsKey.entries).map(([sym, name]) => (
                  <div className="row" key={sym}>
                    <span className="sym">{sym}</span>
                    <span className="name">{name}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="card legend">
              <h4>You are</h4>
              <div className="row">
                <span className="token" style={{ position: "static", width: 18, height: 18, transition: "none" }} />
                <span className="name">
                  {world.room && world.rooms[world.room]
                    ? `in the ${world.rooms[world.room]}`
                    : "somewhere in the building"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {phase === "trialEnd" && (
        <div className="overlay">
          <div className="panel">
            <div style={{ display: "grid", placeItems: "center" }}>
              <RobotAvatar mood={endMood} size={84} />
            </div>
            {payload.outcome ? (
              <>
                <h2>{payload.outcome.correct ? "You got it!" : "Not quite."}</h2>
                <p>
                  {payload.outcome.correct
                    ? "That's exactly what the robot needed. Nice."
                    : payload.outcome.reason === "timeout"
                      ? "Time ran out on that one."
                      : payload.outcome.reason === "budget_exhausted"
                        ? "You ran out of moves."
                        : "That wasn't the part it meant."}
                </p>
              </>
            ) : (
              <>
                <h2>Mission logged.</h2>
                <p>On to the next one.</p>
              </>
            )}
            <button className="btn" onClick={goNext}>
              {payload.missionNumber >= payload.missionTotal ? "Finish" : "Next mission →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
