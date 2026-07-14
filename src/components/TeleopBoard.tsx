"use client";

// Renders the teleop grid from the LISTENER view only. The goal is NEVER sent by
// the server (§6), so it cannot be shown here. Start is marked; the robot token
// is at the current position.

export type TeleopCell = "wall" | "floor";

export interface TeleopListenerWorld {
  scene: string;
  cells: TeleopCell[][];
  width: number;
  height: number;
  start: [number, number];
  pos: [number, number];
  keypad: string[];
  discovered: string[];
}

function cellSize(width: number): number {
  return Math.max(30, Math.min(52, Math.floor(520 / width)));
}

export function TeleopBoard({ world }: { world: TeleopListenerWorld }) {
  const { width, height, cells, pos, start } = world;
  const CELL = cellSize(width);

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
        rowArr.map((type, c) => <div key={`${c},${r}`} className={`cell ${type}`} />),
      )}

      {/* start marker */}
      <div
        className="tele-start"
        style={{ left: start[0] * CELL, top: start[1] * CELL, width: CELL, height: CELL }}
      >
        <span>start</span>
      </div>

      {/* robot token */}
      <div
        className="token"
        style={{ left: pos[0] * CELL + CELL * 0.19, top: pos[1] * CELL + CELL * 0.19 }}
      />
    </div>
  );
}

export function Keypad({
  keys,
  discovered,
  controlKey,
  onPress,
  disabled,
}: {
  keys: string[];
  discovered: string[];
  controlKey?: Record<string, string>; // known mappings (expert full, novice discovered)
  onPress: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="keypad">
      {keys.map((k) => {
        const dir = controlKey?.[k];
        const known = dir != null;
        return (
          <button
            key={k}
            className={`key ${known ? "known" : ""}`}
            onClick={() => !disabled && onPress(k)}
            disabled={disabled}
          >
            <span className="letter">{k}</span>
            <span className="dir">{known ? dirArrow(dir!) : discovered.includes(k) ? "·" : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

function dirArrow(dir: string): string {
  return dir === "up" ? "↑" : dir === "down" ? "↓" : dir === "left" ? "←" : dir === "right" ? "→" : "";
}
