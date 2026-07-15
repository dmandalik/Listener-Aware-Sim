"use client";

// Renders the teleop grid from the LISTENER view only. The goal is NEVER sent by
// the server (§6), so it cannot be shown here. Start is marked; the robot token
// is at the current position.

export type TeleopCell = "wall" | "floor";

export interface TeleopLandmark {
  name: string;
  icon: string;
  pos: [number, number];
}

export interface TeleopListenerWorld {
  scene: string;
  cells: TeleopCell[][];
  width: number;
  height: number;
  start: [number, number];
  pos: [number, number];
  keypad: string[];
  landmarks: TeleopLandmark[];
  /** Goal — present ONLY on the speaker's board; the listener never receives it. */
  goal?: [number, number];
}

function cellSize(width: number): number {
  return Math.max(30, Math.min(52, Math.floor(520 / width)));
}

export function TeleopBoard({ world }: { world: TeleopListenerWorld }) {
  const { width, height, cells, pos, start, goal, landmarks } = world;
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

      {/* landmarks — visible to everyone; the shared reference frame for the route */}
      {(landmarks ?? []).map((lm) => (
        <div
          key={lm.name}
          className="tele-landmark"
          title={lm.name}
          style={{ left: lm.pos[0] * CELL, top: lm.pos[1] * CELL, width: CELL, height: CELL }}
        >
          <span style={{ fontSize: CELL * 0.55, lineHeight: 1 }}>{lm.icon}</span>
        </div>
      ))}

      {/* goal marker — speaker board only (the listener never receives `goal`) */}
      {goal && (
        <div
          className="cell is-target"
          style={{ position: "absolute", left: goal[0] * CELL, top: goal[1] * CELL, width: CELL, height: CELL }}
        >
          <span className="tele-goal">goal</span>
        </div>
      )}

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
  controlKey,
  onPress,
  disabled,
}: {
  keys: string[];
  controlKey?: Record<string, string>; // known mappings — expert only; absent for novice
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
            {/* Only expert sees the arrow; for a novice the letter stays centered. */}
            {known && <span className="dir">{dirArrow(dir!)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function dirArrow(dir: string): string {
  return dir === "up" ? "↑" : dir === "down" ? "↓" : dir === "left" ? "←" : dir === "right" ? "→" : "";
}
