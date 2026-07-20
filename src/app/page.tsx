"use client";

import { useCallback, useEffect, useState } from "react";
import { RobotAvatar } from "@/components/RobotAvatar";
import { isMobileDevice } from "@/lib/mobile";

const AGES = ["18–24", "25–34", "35–44", "45–54", "55–64", "65 or older", "Prefer not to say"];
const GENDERS = ["Woman", "Man", "Non-binary", "Prefer to self-describe", "Prefer not to say"];
// Robot familiarity self-report (required). Index 0–4 is stored; the wording runs
// from no experience at all to using robots as part of one's job.
const ROBOT_FAMILIARITY = [
  "Not at all — I have never used or interacted with a robot",
  "Slightly — I have tried one a few times",
  "Somewhat — I use or interact with robots now and then",
  "Very — I use robots regularly",
  "Extremely — I work with robots frequently as part of my job",
];
const RACES = [
  "Asian",
  "Black or African American",
  "Hispanic or Latino",
  "Middle Eastern or North African",
  "Native American or Alaska Native",
  "Native Hawaiian or Pacific Islander",
  "White",
  "Prefer not to say",
  "Other",
];
const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  fontSize: 16,
  fontFamily: "var(--font-sans)",
};

type Cfg = {
  requireProlific: boolean;
  consent: {
    title: string;
    sections: Array<{ h?: string; p: string; bold?: boolean }>;
    agreeLabel: string;
    declineLabel: string;
  };
  completeUrl: string;
  screenoutUrl: string;
};
type Step = "loading" | "no-params" | "mobile" | "consent" | "name" | "go" | "screened";

export default function Entry() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [genderOther, setGenderOther] = useState("");
  const [race, setRace] = useState<string[]>([]);
  const [raceOther, setRaceOther] = useState("");
  const [robotFamiliarity, setRobotFamiliarity] = useState<number | null>(null);
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
    const f = firstName.trim();
    const l = lastName.trim();
    sessionStorage.setItem("participantFirstName", f);
    sessionStorage.setItem("participantLastName", l);
    sessionStorage.setItem("participantEmail", email.trim());
    sessionStorage.setItem("participantName", [f, l].filter(Boolean).join(" "));
    // Demographics collected up front; sent to /play/start and saved with the session.
    sessionStorage.setItem(
      "participantDemographics",
      JSON.stringify({
        ageRange: age || null,
        gender: gender || null,
        genderOther: gender === "Prefer to self-describe" ? genderOther.trim() || null : null,
        race,
        raceOther: race.includes("Other") ? raceOther.trim() || null : null,
        robotFamiliarity,
      }),
    );
    setStep("go");
    const qs = new URLSearchParams(params).toString();
    window.location.assign(qs ? `/play?${qs}` : "/play");
  }, [params, firstName, lastName, email, age, gender, genderOther, race, raceOther, robotFamiliarity]);

  const agree = useCallback(() => {
    setStep("name");
  }, []);

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
        <p style={{ color: "var(--ink-soft)", lineHeight: 1.5 }}>
          No problem — you have not started the study and nothing has been recorded. You can close this
          tab now.
        </p>
      </>,
    );
  }

  if (step === "consent" && cfg) {
    return (
      <main className="center-screen">
        <div className="card" style={{ padding: 0, width: "min(680px, 94vw)", display: "flex", flexDirection: "column", maxHeight: "92vh" }}>
          <div style={{ padding: "26px 32px 8px" }}>
            <div className="eyebrow">Listener Aware Simulation</div>
            <h1 style={{ margin: "4px 0 2px", fontSize: 24 }}>{cfg.consent.title}</h1>
          </div>
          <div style={{ overflowY: "auto", padding: "8px 32px", flex: 1 }}>
            {cfg.consent.sections.map((s, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                {s.h && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{s.h}</div>}
                <p style={{ margin: 0, color: "var(--ink)", lineHeight: 1.55, fontSize: 14, fontWeight: s.bold ? 700 : 400 }}>{s.p}</p>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, padding: "12px 32px 24px", borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
            <button className="btn" onClick={agree}>
              {cfg.consent.agreeLabel}
            </button>
            <button className="btn ghost" onClick={() => setStep("screened")}>{cfg.consent.declineLabel}</button>
          </div>
        </div>
      </main>
    );
  }

  if (step === "name") {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    // Robot familiarity is REQUIRED (unlike the optional demographics below).
    const canStart = !!firstName.trim() && !!lastName.trim() && emailOk && robotFamiliarity != null;
    // Plain helper (NOT a component) so inputs keep focus while typing.
    const choice = (
      opts: string[],
      on: (o: string) => boolean,
      pick: (o: string) => void,
      multi?: boolean,
    ) => (
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {opts.map((o) => {
          const sel = on(o);
          return (
            <label
              key={o}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                borderRadius: 8,
                border: `1px solid ${sel ? "var(--accent)" : "var(--line)"}`,
                background: sel ? "var(--accent-wash)" : "transparent",
                cursor: "pointer",
                fontSize: 15,
              }}
            >
              <input
                type={multi ? "checkbox" : "radio"}
                checked={sel}
                onChange={() => pick(o)}
                style={{ accentColor: "var(--accent)" }}
              />
              {o}
            </label>
          );
        })}
      </div>
    );
    const toggleRace = (r: string) =>
      setRace((prev) => {
        if (r === "Prefer not to say") return prev.includes(r) ? [] : ["Prefer not to say"];
        const next = prev.filter((x) => x !== "Prefer not to say");
        return next.includes(r) ? next.filter((x) => x !== r) : [...next, r];
      });
    const label = (t: string) => (
      <div style={{ fontWeight: 600, margin: "18px 0 8px" }}>{t}</div>
    );
    return (
      <main className="center-screen" style={{ alignItems: "flex-start", padding: "32px 20px" }}>
        <div className="card" style={{ padding: 0, width: "min(560px, 94vw)", display: "flex", flexDirection: "column", maxHeight: "90vh" }}>
          <div style={{ padding: "24px 28px 6px" }}>
            <div className="eyebrow">Almost there</div>
            <h2 style={{ margin: "4px 0 2px", fontSize: 22 }}>About you</h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: 0 }}>
              Your name and email label your responses; the demographic questions are optional.
            </p>
            <p style={{ color: "var(--ink)", fontSize: 13, fontWeight: 700, margin: "8px 0 0" }}>
              All information you provide is fully anonymized before analysis.
            </p>
          </div>
          <div style={{ overflowY: "auto", padding: "8px 28px 6px", flex: 1 }}>
            <input autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" maxLength={80} style={fieldStyle} />
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" maxLength={80} style={{ ...fieldStyle, marginTop: 10 }} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" placeholder="Email address" maxLength={160} style={{ ...fieldStyle, marginTop: 10 }} />
            <div style={{ fontWeight: 600, margin: "18px 0 2px" }}>How familiar are you with robots?</div>
            <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 8 }}>This one is required. Pick the option that best describes you.</div>
            {choice(
              ROBOT_FAMILIARITY,
              (o) => robotFamiliarity != null && ROBOT_FAMILIARITY[robotFamiliarity] === o,
              (o) => setRobotFamiliarity(ROBOT_FAMILIARITY.indexOf(o)),
            )}
            {label("What is your age range?")}
            {choice(AGES, (o) => age === o, setAge)}
            {label("Gender identity")}
            {choice(GENDERS, (o) => gender === o, setGender)}
            {gender === "Prefer to self-describe" && (
              <input value={genderOther} onChange={(e) => setGenderOther(e.target.value)} placeholder="Self-describe" maxLength={120} style={{ ...fieldStyle, marginTop: 8 }} />
            )}
            <div style={{ fontWeight: 600, margin: "18px 0 2px" }}>Race / ethnicity</div>
            <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 8 }}>Select all that apply.</div>
            {choice(RACES, (o) => race.includes(o), toggleRace, true)}
            {race.includes("Other") && (
              <input value={raceOther} onChange={(e) => setRaceOther(e.target.value)} placeholder="Self-describe" maxLength={120} style={{ ...fieldStyle, marginTop: 8 }} />
            )}
          </div>
          <div style={{ padding: "12px 28px 20px", borderTop: "1px solid var(--line)" }}>
            <button className="btn" disabled={!canStart} onClick={goToPlay} style={{ width: "100%" }}>Start →</button>
            {!canStart && (
              <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 8, textAlign: "center" }}>Please enter your first name, last name, a valid email, and how familiar you are with robots.</p>
            )}
          </div>
        </div>
      </main>
    );
  }

  return null;
}
