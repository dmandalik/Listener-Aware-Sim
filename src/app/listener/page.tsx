"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrialPayload, ViewAs } from "@/lib/server/listener";
import { GameBoard, type RetrievalListenerWorld } from "@/components/GameBoard";
import { TeleopBoard, Keypad, type TeleopListenerWorld } from "@/components/TeleopBoard";
import { RepairDiagram, type RepairWorldView } from "@/components/RepairDiagram";
import { RobotAvatar, type RobotMood } from "@/components/RobotAvatar";
import { SpeakerPanel } from "@/components/SpeakerPanel";

type Phase = "loading" | "instructions" | "playing" | "trialEnd" | "done" | "error";

// How-to-play copy for the pre-game pop-up AND the in-game reference. Kept short
// and plain for people who’ve never seen this study. Tailored to the listener’s
// familiarity (novice vs expert), since what they can see differs. Emphasis uses
// <strong> (not <b>) because `.game-guide b` is reserved for the section header.
function taskGuide(taskId: string, isExpert: boolean, missionTotal: number): { steps: React.ReactNode[] } {
  const rounds = (
    <>
      You’ll do this <strong>{missionTotal} time{missionTotal === 1 ? "" : "s"}</strong>, and each time the robot
      sends you <strong>one message</strong> to follow.
    </>
  );

  if (taskId === "teleop") {
    return {
      steps: [
        <>You’re the <strong>driver</strong>: steer a robot to its goal. {rounds}</>,
        isExpert ? (
          <>
            <strong>You can’t see the goal</strong> — the message describes where it is using the objects on the
            board. Your key list shows which letter moves the robot which way.
          </>
        ) : (
          <>
            <strong>You can’t see the goal</strong> — the message describes where it is using the objects on the
            board. The move keys are <strong>unlabeled letters</strong>, so part of the task is figuring out which
            key goes which way.
          </>
        ),
        <>Press the letter keys to move. <strong>Every press is one move — don’t waste them.</strong></>,
      ],
    };
  }
  if (taskId === "repair") {
    return {
      steps: [
        <>Your job is to <strong>fix a robot by joining two of its parts</strong>. {rounds}</>,
        isExpert ? (
          <><strong>Every part is labeled</strong> with its name, and the message tells you which two to join.</>
        ) : (
          <>
            <strong>Several parts look alike and none are labeled</strong>, so the message points to the right ones
            by <strong>where they sit</strong> on the board.
          </>
        ),
        <><strong>Drag one part onto the other</strong> to connect them.</>,
      ],
    };
  }
  // retrieval
  return {
    steps: [
      <>Your job is to <strong>pick up the one part</strong> a broken robot needs. {rounds}</>,
      isExpert ? (
        <>
          You can see the <strong>whole building and every room’s name</strong>, plus a list of the parts. You only
          see the items themselves once you <strong>step into a room</strong>.
        </>
      ) : (
        <>
          You can <strong>only see inside the room you’re in</strong> — you won’t know a room’s name until you enter
          it, and you have no parts list, just their shapes.
        </>
      ),
      <>
        Move with the <strong>arrow keys or WASD</strong>, then <strong>click the item</strong> the message means.{" "}
        <strong>You get one pick — choose carefully.</strong>
      </>,
    ],
  };
}

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

  const [completeUrl, setCompleteUrl] = useState<string | null>(null);
  useEffect(() => {
    setDev(new URLSearchParams(window.location.search).get("dev") === "1");
    fetch("/api/study-config").then((r) => r.json()).then((c) => setCompleteUrl(c.completeUrl)).catch(() => {});
  }, []);

  const beginTrial = useCallback(async (p: TrialPayload) => {
    setBudgetTotal(p.view?.budgetLeft || 1);
    setTimeLeft(Math.round((p.timeoutMs || 0) / 1000));
    // Show the how-to-play pop-up (timer paused) before the FIRST mission. Later
    // missions are gated by the "Next mission" button, so they start straight away.
    setPhase(p.terminal ? "trialEnd" : p.trialIndex === 0 ? "instructions" : "playing");
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
          studyName: qs.get("study") ?? "listener_pilot", // dev: ?study=teleop_pilot
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
  const pressKey = useCallback((key: string) => send({ type: "key", key }), [send]);
  const connectParts = useCallback((from: string, to: string) => send({ type: "connect", from, to }), [send]);

  const taskId = payload?.taskId;
  const teleopKeypad: string[] = (payload?.view?.world as any)?.keypad ?? [];

  // Keyboard control. Task-aware. Disabled in the Speaker view.
  useEffect(() => {
    if (phase !== "playing" || viewAs === "speaker") return;
    const onKey = (e: KeyboardEvent) => {
      if (taskId === "teleop") {
        // Any keypad letter is a press (mapped or decoy — both cost budget, §6).
        const k = e.key.toUpperCase();
        if (teleopKeypad.includes(k)) {
          e.preventDefault();
          void pressKey(k);
        }
        return;
      }
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
  }, [phase, move, pressKey, viewAs, taskId, teleopKeypad]);

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
          <p style={{ color: "var(--ink-soft)", marginBottom: 20 }}>
            Thank you — your data has been recorded.
          </p>
          {completeUrl && (
            <a className="btn" href={completeUrl} style={{ display: "inline-block", textDecoration: "none" }}>
              Finish &amp; return to Prolific
            </a>
          )}
        </div>
      </main>
    );
  }

  if (!payload || !payload.view) return null;
  const isTeleop = payload.taskId === "teleop";
  const isRepair = payload.taskId === "repair";
  const world = payload.view.world as unknown as RetrievalListenerWorld;
  const teleWorld = payload.view.world as unknown as TeleopListenerWorld;
  const repairWorld = payload.view.world as unknown as RepairWorldView;
  const partsKey = payload.view.keys.find((k) => k.id === "parts");
  const controlKey = payload.view.keys.find((k) => k.id === "control");
  // Expert iff they actually hold the task's key (this reflects the current view,
  // including the dev toggle) — used to tailor the instructions.
  const isExpertView = isRepair
    ? !!(payload.view.world as any).labelled
    : isTeleop
      ? !!controlKey?.entries
      : !!partsKey?.entries;
  const guide = taskGuide(payload.taskId, isExpertView, payload.missionTotal);
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
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              {payload.taskId === "teleop"
                ? "Drive the robot to the goal"
                : payload.taskId === "repair"
                  ? "Fix the robot — connect the right parts"
                  : "Retrieve what the robot needs"}
            </div>
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
            {isRepair ? (
              <>
                {(() => {
                  const rw = payload.view!.world as any;
                  const la = rw.lastAttempt as { from: string; to: string; correct: boolean } | null;
                  return (
                    <>
                      <div className="repair-status">
                        <span className="step">Tries left: {rw.triesLeft}</span>
                        {la && (
                          <span className={`feedback ${la.correct ? "ok" : "bad"}`}>
                            {la.correct ? "✓ connected!" : "✗ those don't connect — try again"}
                          </span>
                        )}
                      </div>
                      <RepairDiagram
                        world={repairWorld}
                        onConnect={connectParts}
                        disabled={phase !== "playing"}
                        flash={la ? { from: la.from, to: la.to, correct: la.correct, key: rw.attemptCount } : null}
                      />
                    </>
                  );
                })()}
              </>
            ) : isTeleop ? (
              <>
                <TeleopBoard world={teleWorld} />
                <Keypad
                  keys={teleWorld.keypad}
                  controlKey={controlKey?.entries}
                  onPress={pressKey}
                  disabled={phase !== "playing"}
                />
              </>
            ) : (
              <GameBoard world={world} onPick={pick} disabled={phase !== "playing"} />
            )}
          </div>

          {/* repair is a single click — no budget/keys side panel */}
          {isRepair ? null : (
          <div className="side">
            <div className="card budget">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
                  {isTeleop ? "Presses left" : "Moves left"}
                </span>
                <b style={{ fontVariantNumeric: "tabular-nums" }}>{budgetLeft}</b>
              </div>
              <div className="meter">
                <div className={`fill ${low ? "low" : ""}`} style={{ width: `${budgetPct}%` }} />
              </div>
              <div className="nums">
                <span>{isTeleop ? "each press costs 1" : "each move costs 1"}</span>
                <span>{budgetTotal} total</span>
              </div>
            </div>

            {isTeleop ? (
              // Control key — expert has it all; novice fills in as they discover
              // (absent until the first discovery). §11 guardrail: absent, not greyed.
              controlKey?.entries && Object.keys(controlKey.entries).length > 0 ? (
                <div className="card legend">
                  <h4>Controls</h4>
                  {Object.entries(controlKey.entries).map(([k, dir]) => (
                    <div className="row" key={k}>
                      <span className="sym">{k}</span>
                      <span className="name">{dir}</span>
                    </div>
                  ))}
                </div>
              ) : null
            ) : (
              <>
                {/* Parts key — rendered ONLY when the listener has it (§11). */}
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
              </>
            )}
          </div>
          )}
        </div>

        {/* full instructions kept at the bottom for reference during play */}
        <div className="game-guide">
          <b>How to play</b>
          <ul>
            {guide.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
      )}

      {phase === "instructions" && (
        <div className="overlay">
          <div className="panel" style={{ width: "min(500px, 92vw)", textAlign: "left" }}>
            <div style={{ display: "grid", placeItems: "center", marginBottom: 6 }}>
              <RobotAvatar mood="hopeful" size={72} />
            </div>
            <h2 style={{ textAlign: "center", margin: "0 0 14px" }}>How to play</h2>
            <ol style={{ margin: "0 0 14px", paddingLeft: 20, lineHeight: 1.55, color: "var(--ink)" }}>
              {guide.steps.map((s, i) => (
                <li key={i} style={{ marginBottom: 8 }}>{s}</li>
              ))}
            </ol>
            <div className="banner-alert" style={{ background: "var(--accent-wash)", border: "1px solid var(--accent)", color: "var(--accent-ink)" }}>
              ⏱ The timer is your <b>time limit</b> — but <b>faster is better</b>. Your speed is
              recorded, so finish as quickly as you can.
            </div>
            <div style={{ display: "grid", placeItems: "center", marginTop: 18 }}>
              <button className="btn" onClick={() => setPhase("playing")}>
                Start mission {payload.missionNumber} of {payload.missionTotal} →
              </button>
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
