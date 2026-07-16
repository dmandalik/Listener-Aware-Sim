"use client";

// End-of-study survey: demographics + NASA-TLX (raw, 0–100) + one open-ended
// feedback question. Shown after the final round for speakers and listeners.
// Saves to /api/survey; calls onDone() when submitted.

import { useState } from "react";
import { RobotAvatar } from "@/components/RobotAvatar";

const AGES = ["18–24", "25–34", "35–44", "45–54", "55–64", "65 or older", "Prefer not to say"];
const GENDERS = ["Woman", "Man", "Non-binary", "Prefer to self-describe", "Prefer not to say"];
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

const TLX = [
  { key: "tlxMental", label: "Mental demand", q: "How mentally demanding were the games?", lo: "Very low", hi: "Very high" },
  { key: "tlxPhysical", label: "Physical demand", q: "How physically demanding were the games?", lo: "Very low", hi: "Very high" },
  { key: "tlxTemporal", label: "Temporal demand", q: "How hurried or rushed did the pace feel?", lo: "Very low", hi: "Very high" },
  { key: "tlxPerformance", label: "Performance", q: "How successful were you at doing what you were asked to do?", lo: "Perfect", hi: "Failure" },
  { key: "tlxEffort", label: "Effort", q: "How hard did you have to work to reach your level of performance?", lo: "Very low", hi: "Very high" },
  { key: "tlxFrustration", label: "Frustration", q: "How insecure, discouraged, irritated, or stressed did you feel?", lo: "Very low", hi: "Very high" },
] as const;

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  fontSize: 15,
  fontFamily: "var(--font-sans)",
};

export function EndSurvey({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [genderOther, setGenderOther] = useState("");
  const [race, setRace] = useState<string[]>([]);
  const [raceOther, setRaceOther] = useState("");
  const [tlx, setTlx] = useState<Record<string, number | null>>({});
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRace = (r: string) => {
    setRace((prev) => {
      if (r === "Prefer not to say") return prev.includes(r) ? [] : ["Prefer not to say"];
      const next = prev.filter((x) => x !== "Prefer not to say");
      return next.includes(r) ? next.filter((x) => x !== r) : [...next, r];
    });
  };

  const allTlxAnswered = TLX.every((t) => tlx[t.key] != null);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          ageRange: age || null,
          gender: gender || null,
          genderOther: gender === "Prefer to self-describe" ? genderOther : null,
          race,
          raceOther: race.includes("Other") ? raceOther : null,
          feedback: feedback || null,
          ...Object.fromEntries(TLX.map((t) => [t.key, tlx[t.key]])),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "save failed");
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );

  const Choices = ({
    options,
    value,
    onPick,
    multi,
    isChecked,
  }: {
    options: string[];
    value?: string;
    onPick: (o: string) => void;
    multi?: boolean;
    isChecked?: (o: string) => boolean;
  }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {options.map((o) => {
        const checked = multi ? !!isChecked?.(o) : value === o;
        return (
          <label
            key={o}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 12px",
              borderRadius: 8,
              border: `1px solid ${checked ? "var(--accent)" : "var(--line)"}`,
              background: checked ? "var(--accent-wash)" : "transparent",
              cursor: "pointer",
              fontSize: 15,
            }}
          >
            <input
              type={multi ? "checkbox" : "radio"}
              checked={checked}
              onChange={() => onPick(o)}
              style={{ accentColor: "var(--accent)" }}
            />
            {o}
          </label>
        );
      })}
    </div>
  );

  return (
    <main className="center-screen" style={{ alignItems: "flex-start", padding: "32px 20px" }}>
      <div style={{ width: "min(620px, 94vw)", margin: "0 auto" }}>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 10 }}>
          <RobotAvatar mood="thanking" size={64} />
        </div>
        <h1 style={{ textAlign: "center", margin: "0 0 6px" }}>A few quick questions</h1>
        <p style={{ textAlign: "center", color: "var(--ink-soft)", marginBottom: 22 }}>
          Almost done — this helps us understand and improve the games. Demographics are optional.
        </p>

        <Section title="About you">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>What is your age range?</div>
          <Choices options={AGES} value={age} onPick={setAge} />

          <div style={{ fontWeight: 600, margin: "18px 0 8px" }}>Gender identity</div>
          <Choices options={GENDERS} value={gender} onPick={setGender} />
          {gender === "Prefer to self-describe" && (
            <input
              style={{ ...field, marginTop: 8 }}
              placeholder="Self-describe (optional)"
              value={genderOther}
              onChange={(e) => setGenderOther(e.target.value)}
              maxLength={120}
            />
          )}

          <div style={{ fontWeight: 600, margin: "18px 0 4px" }}>Race / ethnicity</div>
          <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 8 }}>Select all that apply.</div>
          <Choices options={RACES} multi isChecked={(o) => race.includes(o)} onPick={toggleRace} />
          {race.includes("Other") && (
            <input
              style={{ ...field, marginTop: 8 }}
              placeholder="Self-describe (optional)"
              value={raceOther}
              onChange={(e) => setRaceOther(e.target.value)}
              maxLength={120}
            />
          )}
        </Section>

        <Section title="How the games felt">
          <p style={{ color: "var(--ink-soft)", fontSize: 14, margin: "0 0 14px" }}>
            Thinking about the games you just played, drag each slider to where it fits.
          </p>
          {TLX.map((t) => (
            <div key={t.key} style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>{t.label}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: tlx[t.key] == null ? "var(--ink-soft)" : "var(--accent-ink)", fontWeight: 600 }}>
                  {tlx[t.key] == null ? "—" : tlx[t.key]}
                </span>
              </div>
              <div style={{ fontSize: 14, color: "var(--ink)", margin: "2px 0 8px" }}>{t.q}</div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={tlx[t.key] ?? 50}
                onChange={(e) => setTlx((p) => ({ ...p, [t.key]: Number(e.target.value) }))}
                style={{ width: "100%", accentColor: "var(--accent)" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ink-soft)" }}>
                <span>{t.lo}</span>
                <span>{t.hi}</span>
              </div>
            </div>
          ))}
        </Section>

        <Section title="Your feedback">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            In a sentence or two, what worked well and what (if anything) was confusing or frustrating?
          </div>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="e.g., the driving game was clear, but I found the repair parts hard to tell apart…"
            style={{ ...field, resize: "vertical", minHeight: 72 }}
          />
        </Section>

        {error && <p style={{ color: "var(--alert)", marginBottom: 10 }}>{error}</p>}
        <div style={{ display: "grid", placeItems: "center", marginBottom: 40 }}>
          <button className="btn" onClick={submit} disabled={saving || !allTlxAnswered} title={!allTlxAnswered ? "Please answer all six sliders above" : undefined}>
            {saving ? "Submitting…" : "Submit & finish →"}
          </button>
          {!allTlxAnswered && (
            <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 8 }}>
              Please set all six sliders to continue.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
