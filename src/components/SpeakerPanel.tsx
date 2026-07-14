"use client";

// The SPEAKER's view (§3): they see everything — the full map, all objects, the
// target (highlighted), and the parts key — but cannot act. They compose ONE
// message for a novice helper, which is saved to the utterance pool.

import { useRef, useState } from "react";
import { GameBoard, type RetrievalListenerWorld } from "@/components/GameBoard";
import { TeleopBoard, type TeleopListenerWorld } from "@/components/TeleopBoard";
import { RepairDiagram } from "@/components/RepairDiagram";
import { RobotAvatar } from "@/components/RobotAvatar";
import type { SpeakerData } from "@/lib/server/listener";

function dirArrow(dir: string): string {
  return dir === "up" ? "↑" : dir === "down" ? "↓" : dir === "left" ? "←" : dir === "right" ? "→" : "";
}

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
        {data.taskId === "repair" && data.repair ? (
          <>
            <div className="board-wrap">
              <RepairDiagram
                world={{
                  scene: data.repair.world.scene,
                  viewBox: data.repair.world.viewBox,
                  components: data.repair.world.components,
                  labelled: true,
                }}
                connectTarget={data.repair.world.connect}
              />
              <p className="hint" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <span className="legend-target"><span className="ring" /> = the two parts to connect</span>
                <span>You see the wire. The technician must connect them from your words alone.</span>
              </p>
            </div>
            <div className="side" />
          </>
        ) : data.taskId === "teleop" && data.teleop ? (
          <>
            <div className="board-wrap">
              <TeleopBoard
                world={{
                  ...data.teleop.world,
                  pos: data.teleop.world.start,
                } as unknown as TeleopListenerWorld}
              />
              <p className="hint" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <span className="legend-target"><span className="ring" /> = the goal</span>
                <span>You see the whole track and the goal. The driver sees neither.</span>
              </p>
            </div>
            <div className="side">
              <div className="card legend">
                <h4>Controls</h4>
                {Object.entries(data.teleop.controlMap).map(([k, dir]) => (
                  <div className="row" key={k}>
                    <span className="sym">{k}</span>
                    <span className="name">{dir} {dirArrow(dir)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="board-wrap">
              <GameBoard world={data.retrieval!.world as unknown as RetrievalListenerWorld} />
              <p className="hint" style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <span className="legend-target"><span className="ring" /> = the part to retrieve</span>
                <span>You see the whole building. The helper will not.</span>
              </p>
            </div>
            <div className="side">
              <div className="card legend">
                <h4>Parts Key</h4>
                {Object.entries(data.retrieval!.partsKey).map(([sym, name]) => (
                  <div className="row" key={sym}>
                    <span className="sym">{sym}</span>
                    <span className="name">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="card compose">
        <label style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
          Your one message to the helper
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            data.taskId === "teleop"
              ? "e.g. Drive right to the apple, then down two tiles to the goal…"
              : data.taskId === "repair"
                ? "e.g. Drag the middle socket on the left onto the round gauge…"
                : "e.g. Go up two rooms and left to the far corner; grab the star-shaped part…"
          }
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
