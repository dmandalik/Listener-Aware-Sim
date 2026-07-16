"use client";

// Renders the retrieval board from the LISTENER view only. Everything here is
// already fog-filtered by the server (§9.6): `objects` holds current-room objects
// only, `rooms` holds only labels the listener may see. This component must never
// receive or infer anything the condition hides.
//
// Fog visual: every cell NOT in the listener's current room is hazed over, so the
// player can see the building's layout but understands the CONTENTS are hidden
// until they walk in. This reveals nothing (no object data for other rooms is
// ever sent) — it just makes the existing fog of war legible (§11).

import { HumanToken } from "@/components/BoardTokens";

export type CellType = "wall" | "floor" | "door";

export interface BoardObject {
  id: string;
  symbol: string;
  pos: [number, number];
  isTarget?: boolean;
  part?: string;
}

export interface RetrievalListenerWorld {
  scene: string;
  cells: CellType[][];
  roomOf: (string | null)[][];
  width: number;
  height: number;
  rooms: Record<string, string>;
  objects: BoardObject[];
  /** Present for the LISTENER (drives fog + token). Absent for the SPEAKER. */
  pos?: [number, number];
  room?: string;
  /** Present for the SPEAKER only: the cell where the helper/listener will start,
   *  drawn as a labelled "START" marker so the speaker can anchor their directions. */
  startPos?: [number, number];
  /** Retrieval: attempts remaining before the trial fails, and the id of the wrong
   *  object stepped on this move (for a brief "wrong part" note). Listener only. */
  attemptsLeft?: number;
  lastWrong?: string | null;
}

// Fit the board into a comfortable width; clamp so small maps aren't huge and
// large maps aren't tiny.
function cellSize(width: number): number {
  return Math.max(24, Math.min(42, Math.floor(760 / width)));
}

export function GameBoard({
  world,
  onPick,
  disabled,
}: {
  world: RetrievalListenerWorld;
  onPick?: (objectId: string) => void;
  disabled?: boolean;
}) {
  const { width, height, cells, roomOf, objects, pos, rooms, room, startPos } = world;
  const CELL = cellSize(width);

  // Centroids for the visible room labels.
  const centroids: Record<string, { x: number; y: number; n: number }> = {};
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const label = roomOf[r]?.[c];
      if (label && rooms[label]) {
        const acc = (centroids[label] ??= { x: 0, y: 0, n: 0 });
        acc.x += c;
        acc.y += r;
        acc.n += 1;
      }
    }
  }

  return (
    <div
      className="board"
      style={
        {
          "--cell": `${CELL}px`,
          gridTemplateColumns: `repeat(${width}, ${CELL}px)`,
          gridTemplateRows: `repeat(${height}, ${CELL}px)`,
        } as React.CSSProperties
      }
    >
      {cells.flatMap((rowArr, r) =>
        rowArr.map((type, c) => {
          // Fog only applies to the listener (when a current room is set).
          const fog = room != null && type !== "wall" && roomOf[r]?.[c] !== room;
          return <div key={`${c},${r}`} className={`cell ${type}${fog ? " fog" : ""}`} />;
        }),
      )}

      {/* room labels (only those the listener may see) */}
      {Object.entries(centroids).map(([label, a]) => (
        <div
          key={`lbl-${label}`}
          className="room-label"
          style={{ left: (a.x / a.n + 0.5) * CELL, top: (a.y / a.n + 0.5) * CELL }}
        >
          {rooms[label]}
        </div>
      ))}

      {/* objects. Listener: current-room only, clickable. Speaker: all, target
          ringed, not clickable. */}
      {objects.map((o) => {
        const pickable = !!onPick && !disabled;
        return (
          <div
            key={o.id}
            className={`cell reveal${o.isTarget ? " is-target" : ""}${pickable ? " pickable" : ""}`}
            style={{
              position: "absolute",
              left: o.pos[0] * CELL,
              top: o.pos[1] * CELL,
              width: CELL,
              height: CELL,
            }}
            title={pickable ? "Click to pick this up" : o.part}
            onClick={() => pickable && onPick!(o.id)}
          >
            <span
              className="symbol"
              title={pickable ? "Click to pick this up" : o.part}
              onClick={() => pickable && onPick!(o.id)}
              style={{ cursor: pickable ? "pointer" : "default" }}
            >
              {o.symbol}
            </span>
          </div>
        );
      })}

      {/* the listener token — a human helper (absent for the speaker) */}
      {pos && (
        <div
          style={{
            position: "absolute",
            left: pos[0] * CELL,
            top: pos[1] * CELL,
            width: CELL,
            height: CELL,
            display: "grid",
            placeItems: "center",
            transition: "left 150ms ease, top 150ms ease",
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <HumanToken size={CELL * 0.82} />
        </div>
      )}

      {/* the helper's starting cell (speaker view only) — the human icon plus a
          "START" tag, so the speaker sees who begins here and can give directions
          relative to it */}
      {startPos && (
        <div
          title="Where the helper starts"
          style={{
            position: "absolute",
            left: startPos[0] * CELL,
            top: startPos[1] * CELL,
            width: CELL,
            height: CELL,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
            zIndex: 4,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <HumanToken size={CELL * 0.72} />
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                color: "#fff",
                background: "#16a34a",
                padding: "1px 5px",
                borderRadius: 6,
                letterSpacing: "0.04em",
                lineHeight: 1.4,
                whiteSpace: "nowrap",
              }}
            >
              START
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
