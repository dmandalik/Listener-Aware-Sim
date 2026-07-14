"use client";

// The SPEAKER's view (§3): they see everything — the full map, all objects, the
// target (highlighted), and the parts key — but cannot act. They compose ONE
// message for a novice helper, which is saved to the utterance pool.

import { useRef, useState } from "react";
import { GameBoard, type RetrievalListenerWorld } from "@/components/GameBoard";
import { RobotAvatar } from "@/components/RobotAvatar";
import type { SpeakerData } from "@/lib/server/listener";

export function SpeakerPanel({
  data,
  onSave,
}: {
  data: SpeakerData;
  onSave: (text: string, composeMs: number) => Promise<void>;
}) {
  const [text, setText] = useState(data.savedUtterance ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(data.savedUtterance);
  const shownAt = useRef<number>(Date.now());

  const submit = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(text.trim(), Date.now() - shownAt.current);
      setSaved(text.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card speaker-brief">
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <RobotAvatar mood="sad" size={44} />
          <div>
            <div className="eyebrow" style={{ color: "var(--gold)" }}>Speaker briefing</div>
            <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{data.description}</p>
            <p className="prompt">{data.prompt}</p>
          </div>
        </div>
      </div>

      <div className="play-area">
        <div className="board-wrap">
          <GameBoard world={data.world as unknown as RetrievalListenerWorld} />
          <p className="hint" style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span className="legend-target"><span className="ring" /> = the part to retrieve</span>
            <span>You see the whole building. The helper will not.</span>
          </p>
        </div>

        <div className="side">
          <div className="card legend">
            <h4>Parts Key</h4>
            {Object.entries(data.partsKey).map(([sym, name]) => (
              <div className="row" key={sym}>
                <span className="sym">{sym}</span>
                <span className="name">{name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card compose">
        <label style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
          Your one message to the helper
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Go up two rooms and left to the far corner; grab the star-shaped part…"
        />
        <div className="row">
          <span className="saved">{saved ? "✓ Saved to the pool" : " "}</span>
          <button className="btn" onClick={submit} disabled={saving || !text.trim()}>
            {saving ? "Saving…" : saved ? "Update message" : "Save message"}
          </button>
        </div>
      </div>
    </div>
  );
}
