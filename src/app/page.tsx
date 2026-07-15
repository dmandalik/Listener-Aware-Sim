"use client";

import { useCallback, useEffect, useState } from "react";
import { RobotAvatar } from "@/components/RobotAvatar";
import { isMobileDevice } from "@/lib/mobile";

type Cfg = {
  requireProlific: boolean;
  consent: { title: string; body: string; agreeLabel: string; declineLabel: string };
  completeUrl: string;
  screenoutUrl: string;
};
type Step = "loading" | "no-params" | "mobile" | "consent" | "name" | "go" | "screened";

export default function Entry() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [name, setName] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const p: Record<string, string> = {};
    for (const k of ["PROLIFIC_PID", "STUDY_ID", "SESSION_ID"]) {
      const v = qs.get(k);
      if (v) p[k] = v;
    }
    setParams(p);
    fetch("/api/study-config")
      .then((r) => r.json())
      .then((c: Cfg) => {
        setCfg(c);
        // Mobile is blocked first, before consent (§8).
        if (isMobileDevice()) return setStep("mobile");
        if (c.requireProlific && (!p.PROLIFIC_PID || !p.STUDY_ID || !p.SESSION_ID)) return setStep("no-params");
        setStep("consent");
      })
      .catch(() => setStep("consent"));
  }, []);

  const goToPlay = useCallback(() => {
    sessionStorage.setItem("participantName", name.trim());
    setStep("go");
    const qs = new URLSearchParams(params).toString();
    window.location.assign(qs ? `/play?${qs}` : "/play");
  }, [params, name]);

  const card = (children: React.ReactNode, width = 560) => (
    <main className="center-screen">
      <div className="card" style={{ padding: 34, width: `min(${width}px, 94vw)` }}>{children}</div>
    </main>
  );

  if (step === "loading" || step === "go") {
    return (
      <main className="center-screen">
        <div className="stack" style={{ alignItems: "center", gap: 12 }}>
          <RobotAvatar mood="waiting" size={64} />
          <p style={{ color: "var(--ink-soft)" }}>{step === "go" ? "Starting…" : "Loading…"}</p>
        </div>
      </main>
    );
  }

  if (step === "no-params") {
    return card(
      <>
        <div className="eyebrow" style={{ color: "var(--alert)" }}>Can’t start</div>
        <h1 style={{ margin: "6px 0 10px", fontSize: 24 }}>Please open this study from Prolific.</h1>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.5 }}>
          This page needs your Prolific ID, which is added automatically when you follow the study
          link on Prolific. Return to Prolific and click the study link there.
        </p>
      </>,
    );
  }

  if (step === "mobile") {
    return card(
      <>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 6 }}>
          <RobotAvatar mood="sad" size={72} />
        </div>
        <h1 style={{ margin: "6px 0 10px", fontSize: 24, textAlign: "center" }}>Desktop or laptop required</h1>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.5, textAlign: "center" }}>
          This study uses the keyboard and a mouse or trackpad, so it can’t run on a phone or tablet.
          Please reopen the Prolific study link on a computer.
        </p>
      </>,
    );
  }

  if (step === "screened") {
    return card(
      <>
        <div className="eyebrow">Thanks for your time</div>
        <h1 style={{ margin: "6px 0 10px", fontSize: 24 }}>You’ve chosen not to continue.</h1>
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.5, marginBottom: 20 }}>
          No problem — you can return to Prolific now.
        </p>
        <a className="btn" href={cfg?.screenoutUrl ?? "#"} style={{ display: "inline-block", textDecoration: "none" }}>
          Return to Prolific
        </a>
      </>,
    );
  }

  if (step === "consent" && cfg) {
    return card(
      <>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 6 }}>
          <RobotAvatar mood="hopeful" size={72} />
        </div>
        <div className="eyebrow">The Fetch Games</div>
        <h1 style={{ margin: "4px 0 12px", fontSize: 26 }}>{cfg.consent.title}</h1>
        <p style={{ color: "var(--ink)", lineHeight: 1.6, fontSize: 15 }}>{cfg.consent.body}</p>
        <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => setStep("name")}>{cfg.consent.agreeLabel}</button>
          <a className="btn ghost" href={cfg.screenoutUrl} style={{ textDecoration: "none" }}>{cfg.consent.declineLabel}</a>
        </div>
      </>,
      620,
    );
  }

  if (step === "name") {
    return card(
      <>
        <div className="eyebrow">Almost there</div>
        <h2 style={{ margin: "6px 0 8px", fontSize: 22 }}>What’s your name?</h2>
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginBottom: 14 }}>
          We use it only to label your responses in the study.
        </p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && goToPlay()}
          placeholder="Your name"
          maxLength={120}
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            fontSize: 16,
            fontFamily: "var(--font-sans)",
          }}
        />
        <button className="btn" style={{ marginTop: 16 }} disabled={!name.trim()} onClick={goToPlay}>
          Start →
        </button>
      </>,
    );
  }

  return null;
}
