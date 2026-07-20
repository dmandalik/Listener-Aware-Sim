"use client";

// Per-trial NASA-TLX (raw, 0–100 per item), shown after EACH trial so workload can be
// compared across tasks/utterances. The open-ended feedback box appears ONLY on the
// final trial. Saves to /api/trial-survey; calls onDone() when submitted.

import { useState } from "react";
import { RobotAvatar } from "@/components/RobotAvatar";

const TLX = [
  { key: "tlxMental", label: "Mental demand", q: "How mentally demanding was this round?", lo: "Very low", hi: "Very high" },
  { key: "tlxPhysical", label: "Physical demand", q: "How physically demanding was this round?", lo: "Very low", hi: "Very high" },
  { key: "tlxTemporal", label: "Temporal demand", q: "How hurried or rushed did the pace feel?", lo: "Very low", hi: "Very high" },
  { key: "tlxPerformance", label: "Performance", q: "How successful were you at doing what you were asked to do?", lo: "Failure", hi: "Perfect" },
  { key: "tlxEffort", label: "Effort", q: "How hard did you have to work to accomplish your level of performance?", lo: "Very low", hi: "Very high" },
  { key: "tlxFrustration", label: "Frustration", q: "How insecure, discouraged, irritated, or stressed were you?", lo: "Very low", hi: "Very high" },
] as const;

// Module-level (stable identity) so the feedback textarea never remounts on state
// change, which would drop input focus.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

export function TrialSurvey({
  sessionId,
  trialIndex,
  isLast,
  missionNumber,
  missionTotal,
  onDone,
}: {
  sessionId: string;
  trialIndex: number;
  isLast: boolean;
  missionNumber: number;
  missionTotal: number;
  onDone: () => void;
}) {
  // Every slider starts at the neutral midpoint so it always counts as answered.
  const [tlx, setTlx] = useState<Record<string, number>>(() =>
    Object.fromEntries(TLX.map((t) => [t.key, 50])),
  );
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/trial-survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          trialIndex,
          // Performance is shown Failure→Perfect (drag right = better); store canonical
          // NASA-TLX (higher = worse) so all six items and the average stay consistent.
          ...Object.fromEntries(
            TLX.map((t) => [t.key, t.key === "tlxPerformance" ? 100 - (tlx[t.key] ?? 50) : tlx[t.key]]),
          ),
          ...(isLast ? { feedback: feedback || null } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "save failed");
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <main className="center-screen" style={{ alignItems: "flex-start", padding: "32px 20px" }}>
      <div style={{ width: "min(620px, 94vw)", margin: "0 auto" }}>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 10 }}>
          <RobotAvatar mood={isLast ? "thanking" : "hopeful"} size={64} />
        </div>
        <h1 style={{ textAlign: "center", margin: "0 0 6px" }}>Quick check-in</h1>
        <p style={{ textAlign: "center", color: "var(--ink-soft)", marginBottom: 22 }}>
          {isLast
            ? "Last one. How did that final round feel?"
            : `How did that round feel? (round ${missionNumber} of ${missionTotal})`}
        </p>

        <Section title="How this round felt">
          <p style={{ color: "var(--ink-soft)", fontSize: 14, margin: "0 0 14px" }}>
            Drag each slider to where it fits for the round you just did. Each starts in the middle.
          </p>
          {TLX.map((t) => (
            <div key={t.key} style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>{t.label}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--accent-ink)", fontWeight: 600 }}>
                  {tlx[t.key]}
                </span>
              </div>
              <div style={{ fontSize: 14, color: "var(--ink)", margin: "2px 0 8px" }}>{t.q}</div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={tlx[t.key]}
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

        {isLast && (
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
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--line)",
                fontSize: 15,
                fontFamily: "var(--font-sans)",
                resize: "vertical",
                minHeight: 72,
              }}
            />
          </Section>
        )}

        {error && <p style={{ color: "var(--alert)", marginBottom: 10 }}>{error}</p>}
        <div style={{ display: "grid", placeItems: "center", marginBottom: 40 }}>
          <button className="btn" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isLast ? "Submit & finish →" : "Continue →"}
          </button>
        </div>
      </div>
    </main>
  );
}
