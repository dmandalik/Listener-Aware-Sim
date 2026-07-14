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

export type CellType = "wall" | "floor" | "door";

export interface RetrievalListenerWorld {
  scene: string;
  cells: CellType[][];
  roomOf: (string | null)[][];
  width: number;
  height: number;
  rooms: Record<string, string>;
  objects: Array<{ id: string; symbol: string; pos: [number, number] }>;
  pos: [number, number];
  room: string;
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
  onPick: (objectId: string) => void;
  disabled?: boolean;
}) {
  const { width, height, cells, roomOf, objects, pos, rooms, room } = world;
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
          const fog = type !== "wall" && roomOf[r]?.[c] !== room;
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

      {/* current-room objects (clickable) */}
      {objects.map((o) => (
        <div
          key={o.id}
          className="cell reveal"
          style={{
            position: "absolute",
            left: o.pos[0] * CELL,
            top: o.pos[1] * CELL,
            width: CELL,
            height: CELL,
          }}
        >
          <span
            className="symbol"
            title={disabled ? undefined : "Pick this up"}
            onClick={() => !disabled && onPick(o.id)}
          >
            {o.symbol}
          </span>
        </div>
      ))}

      {/* the listener token */}
      <div
        className="token"
        style={{ left: pos[0] * CELL + CELL * 0.19, top: pos[1] * CELL + CELL * 0.19 }}
      />
    </div>
  );
}
