"use client";

import { useCallback, useEffect, useState } from "react";
import type { SpeakerTrialPayload } from "@/lib/server/listener";
import { SpeakerPanel } from "@/components/SpeakerPanel";
import { RobotAvatar } from "@/components/RobotAvatar";

type Phase = "loading" | "intro" | "composing" | "done" | "error";

async function post(url: string, body: unknown): Promise<SpeakerTrialPayload> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "request failed");
  return json as SpeakerTrialPayload;
}

export default function SpeakerPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [payload, setPayload] = useState<SpeakerTrialPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedThisTrial, setSavedThisTrial] = useState(false);
  const [completeUrl, setCompleteUrl] = useState<string | null>(null);
  const [redirect, setRedirect] = useState(false);
  useEffect(() => {
    fetch("/api/study-config")
      .then((r) => r.json())
      .then((c) => {
        setCompleteUrl(c.completeUrl);
        setRedirect(!!c.prolificRedirect);
      })
      .catch(() => {});
  }, []);

  const begin = useCallback((p: SpeakerTrialPayload) => {
    if (p.done) {
      setPhase("done");
      return;
    }
    setPayload(p);
    setSavedThisTrial(false);
    // Show the one-time briefing pop-up before the first scene; later scenes start
    // straight in (they're already past the intro and gated by "Next scene").
    setPhase(p.trialIndex === 0 ? "intro" : "composing");
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const sid = qs.get("sid");
    // Routed from /play with an assigned speaker session → resume it. Direct
    // /speaker access → start a dev speaker session.
    const req = sid
      ? post("/api/speaker/resume", { sessionId: sid })
      : post("/api/speaker/start", {
          studyName: qs.get("study") ?? "speaker_pilot", // dev: ?study=main_speaker
          prolific: {
            pid: qs.get("PROLIFIC_PID") ?? undefined,
            studyId: qs.get("STUDY_ID") ?? undefined,
            sessionId: qs.get("SESSION_ID") ?? undefined,
          },
        });
    req.then(begin).catch((e) => {
      setError(e.message);
      setPhase("error");
    });
  }, [begin]);

  const saveUtterance = useCallback(
    async (text: string, composeMs: number) => {
      if (!payload) return;
      const res = await fetch("/api/speaker/utterance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: payload.sessionId,
          trialIndex: payload.trialIndex,
          text,
          composeMs,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "save failed");
      setSavedThisTrial(true);
    },
    [payload],
  );

  const goNext = useCallback(async () => {
    if (!payload) return;
    try {
      begin(await post("/api/speaker/next", { sessionId: payload.sessionId }));
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }, [payload, begin]);

  if (phase === "loading") {
    return (
      <main className="center-screen">
        <div className="stack" style={{ alignItems: "center", gap: 14 }}>
          <RobotAvatar mood="waiting" size={72} />
          <p style={{ color: "var(--ink-soft)" }}>Loading the scene…</p>
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
          <h1 style={{ margin: "6px 0 8px" }}>Thank you!</h1>
          <p style={{ color: "var(--ink-soft)", marginBottom: 20 }}>
            Your messages are saved.
          </p>
          {redirect && completeUrl && (
            <a className="btn" href={completeUrl} style={{ display: "inline-block", textDecoration: "none" }}>
              Finish &amp; return to Prolific
            </a>
          )}
        </div>
      </main>
    );
  }

  if (phase === "intro" && payload) {
    return (
      <main className="center-screen">
        <div className="card" style={{ padding: 34, width: "min(560px, 94vw)" }}>
          <div style={{ display: "grid", placeItems: "center", marginBottom: 6 }}>
            <RobotAvatar mood="hopeful" size={72} />
          </div>
          <h2 style={{ textAlign: "center", margin: "0 0 14px" }}>Before you start</h2>
          <p style={{ color: "var(--ink)", lineHeight: 1.6, marginBottom: 12 }}>
            You&rsquo;ll help with <b>3 short games</b> — describing how to drive a robot, repair a robot, and
            fetch a part — with <b>{Math.max(1, Math.round(payload.missionTotal / 3))} scene
            {Math.round(payload.missionTotal / 3) === 1 ? "" : "s"} each</b> ({payload.missionTotal} in total). For
            each scene, write <b>one message</b> describing what needs to be done as clearly as you can — a
            different person (the &ldquo;listener&rdquo;) will later read <b>only your message</b> and try to carry
            it out.
          </p>
          <p style={{ color: "var(--ink)", lineHeight: 1.6, marginBottom: 18 }}>
            <b>Read the briefing at the top of each scene</b> before you write — it explains exactly what
            that scene needs.
          </p>
          <div style={{ display: "grid", placeItems: "center" }}>
            <button className="btn" onClick={() => setPhase("composing")}>
              Start &rarr;
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!payload || !payload.speaker) return null;

  return (
    <div className="game">
      <div className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <RobotAvatar mood="sad" size={44} />
          <div>
            <div className="eyebrow">Scene {payload.missionNumber} of {payload.missionTotal}</div>
            <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>Write the instruction</div>
          </div>
        </div>
        <div className="progress-dots">
          {Array.from({ length: payload.missionTotal }).map((_, i) => (
            <span
              key={i}
              className={`dot ${i < payload.trialIndex ? "done" : i === payload.trialIndex ? "active" : ""}`}
            />
          ))}
        </div>
      </div>

      <SpeakerPanel key={payload.trialIndex} data={payload.speaker} onSave={saveUtterance} />

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
        <button className="btn" onClick={goNext} disabled={!savedThisTrial}>
          {payload.missionNumber >= payload.missionTotal ? "Finish" : "Next scene →"}
        </button>
      </div>
    </div>
  );
}
