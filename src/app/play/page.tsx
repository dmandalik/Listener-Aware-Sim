"use client";

import { useEffect, useState } from "react";
import { RobotAvatar } from "@/components/RobotAvatar";

// Single participant entry. Randomly (balanced) assigns the person to speaker /
// novice / expert, starts the matching session, and routes them there. The
// assignment is fixed for the whole session.
export default function PlayPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const prolific = {
      pid: qs.get("PROLIFIC_PID") ?? undefined,
      studyId: qs.get("STUDY_ID") ?? undefined,
      sessionId: qs.get("SESSION_ID") ?? undefined,
    };
    const dev = qs.get("dev") === "1" ? "&dev=1" : "";
    fetch("/api/play/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prolific }),
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "assignment failed");
        // Route to the matching flow with the started session.
        const route = json.kind === "speaker" ? "speaker" : "listener";
        window.location.replace(`/${route}?sid=${encodeURIComponent(json.sessionId)}${dev}`);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <main className="center-screen">
        <div className="card" style={{ padding: 28, maxWidth: 460 }}>
          <div className="eyebrow" style={{ color: "var(--alert)" }}>Something went wrong</div>
          <p style={{ marginTop: 8 }}>{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="center-screen">
      <div className="stack" style={{ alignItems: "center", gap: 14 }}>
        <RobotAvatar mood="hopeful" size={72} />
        <p style={{ color: "var(--ink-soft)" }}>Assigning your role…</p>
      </div>
    </main>
  );
}
