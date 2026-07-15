"use client";

import { useRef, useState } from "react";

// The repair board (§5): technical-looking parts with made-up names. The listener
// DRAGS one part onto another to connect them; which pair connects isn't visually
// obvious. Novice sees shapes only; expert/speaker get the labels. `connectTarget`
// (speaker) draws the correct wire; `world.connected` draws the wire once the
// listener gets it right; `flash` gives per-attempt feedback.

export interface RepairComponentView {
  id: string;
  shape: string;
  color: string;
  pos: [number, number];
  name?: string;
}

export interface RepairWorldView {
  scene: string;
  viewBox: [number, number];
  components: RepairComponentView[];
  labelled?: boolean;
  connected?: [string, string] | null;
}

const dark = "rgba(0,0,0,0.32)";

function Shape({ shape, color }: { shape: string; color: string }) {
  switch (shape) {
    case "socket":
      return (
        <g>
          <rect x={-26} y={-19} width={52} height={38} rx={6} fill={color} stroke={dark} strokeWidth={2} />
          <rect x={-26} y={-19} width={52} height={8} rx={6} fill="rgba(255,255,255,0.08)" />
          {[-13, 0, 13].map((x) => (
            <circle key={x} cx={x} cy={2} r={4.5} fill="#100f0d" />
          ))}
        </g>
      );
    case "chip":
      return (
        <g>
          {[-18, -6, 6, 18].map((y) => (
            <g key={y}>
              <rect x={-30} y={y - 2} width={8} height={4} fill="#b9b0a0" />
              <rect x={22} y={y - 2} width={8} height={4} fill="#b9b0a0" />
            </g>
          ))}
          <rect x={-22} y={-22} width={44} height={44} rx={4} fill="#26241f" stroke={dark} strokeWidth={2} />
          <path d="M -22 -8 a 8 8 0 0 0 0 16" fill="#3a3630" />
          <circle cx={12} cy={-12} r={3} fill={color} />
        </g>
      );
    case "gauge":
      return (
        <g>
          <circle r={25} fill="#efe9db" stroke={color} strokeWidth={4} />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (Math.PI * 2 * i) / 8;
            return <line key={i} x1={Math.cos(a) * 19} y1={Math.sin(a) * 19} x2={Math.cos(a) * 23} y2={Math.sin(a) * 23} stroke="#8a8072" strokeWidth={2} />;
          })}
          <line x1={0} y1={0} x2={12} y2={-12} stroke="#33302a" strokeWidth={3} strokeLinecap="round" />
          <circle r={3.5} fill="#33302a" />
        </g>
      );
    case "cap":
      return (
        <g>
          <rect x={-14} y={-25} width={28} height={50} rx={7} fill="#4a443b" stroke={dark} strokeWidth={2} />
          <rect x={-14} y={-25} width={28} height={12} rx={7} fill={color} />
          <line x1={0} y1={-8} x2={0} y2={20} stroke="rgba(255,255,255,0.15)" strokeWidth={3} />
        </g>
      );
    case "knob":
      return (
        <g>
          <circle r={23} fill="#ded2bd" stroke={dark} strokeWidth={2} />
          {Array.from({ length: 12 }, (_, i) => {
            const a = (Math.PI * 2 * i) / 12;
            return <line key={i} x1={Math.cos(a) * 19} y1={Math.sin(a) * 19} x2={Math.cos(a) * 23} y2={Math.sin(a) * 23} stroke="#a99f8c" strokeWidth={2} />;
          })}
          <circle r={12} fill="#efe9db" />
          <line x1={0} y1={0} x2={0} y2={-18} stroke={color} strokeWidth={4} strokeLinecap="round" />
        </g>
      );
    case "coil":
      return (
        <path
          d="M-24 0 q 6 -16 12 0 q 6 16 12 0 q 6 -16 12 0 q 6 16 12 0"
          stroke={color}
          strokeWidth={5}
          fill="none"
          strokeLinecap="round"
        />
      );
    case "led":
      return (
        <g>
          <circle r={24} fill={color} opacity={0.22} />
          <circle r={16} fill={color} stroke={dark} strokeWidth={2} />
          <circle r={7} fill="#fff" opacity={0.85} />
        </g>
      );
    case "relay":
      return (
        <g>
          <rect x={-24} y={-17} width={48} height={34} rx={4} fill="#6b6355" stroke={dark} strokeWidth={2} />
          <rect x={-18} y={-11} width={16} height={22} rx={2} fill={color} />
          <circle cx={11} cy={0} r={4} fill="#26241f" />
        </g>
      );
    default:
      return <circle r={20} fill={color} />;
  }
}

function Wire({ a, b, kind }: { a: [number, number]; b: [number, number]; kind: "target" | "made" }) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2 - 26;
  const d = `M ${a[0]} ${a[1]} Q ${mx} ${my} ${b[0]} ${b[1]}`;
  const color = kind === "target" ? "#e0a53f" : "#2f9e8f";
  return (
    <g style={{ pointerEvents: "none" }}>
      <path d={d} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round" opacity={0.22} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray={kind === "target" ? "2 8" : undefined}
      />
    </g>
  );
}

export function RepairDiagram({
  world,
  onConnect,
  disabled,
  connectTarget,
  flash,
}: {
  world: RepairWorldView;
  onConnect?: (from: string, to: string) => void;
  disabled?: boolean;
  connectTarget?: [string, string]; // speaker: draw the correct wire
  flash?: { from: string; to: string; correct: boolean; key: number } | null;
}) {
  const [w, h] = world.viewBox;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  const draggable = !!onConnect && !disabled;

  const byId = (id: string) => world.components.find((c) => c.id === id);
  const toVB = (clientX: number, clientY: number): [number, number] | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const loc = pt.matrixTransform(ctm.inverse());
    return [loc.x, loc.y];
  };
  const nearestTo = (p: [number, number], exclude: string): string | null => {
    let best: string | null = null;
    let bd = 46;
    for (const c of world.components) {
      if (c.id === exclude) continue;
      const d = Math.hypot(c.pos[0] - p[0], c.pos[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = c.id;
      }
    }
    return best;
  };

  return (
    <div className="repair-diagram">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        style={{ maxWidth: 700, display: "block", margin: "0 auto", touchAction: "none", userSelect: "none" }}
        onPointerMove={(e) => {
          if (!dragFrom) return;
          const p = toVB(e.clientX, e.clientY);
          if (p) setPointer(p);
        }}
        onPointerUp={(e) => {
          if (!dragFrom) return;
          const p = toVB(e.clientX, e.clientY);
          const target = p ? nearestTo(p, dragFrom) : null;
          if (target && onConnect) onConnect(dragFrom, target);
          setDragFrom(null);
          setPointer(null);
        }}
        onPointerLeave={() => {
          setDragFrom(null);
          setPointer(null);
        }}
      >
        <defs>
          <pattern id="pcbgrid" width={22} height={22} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill="#3a6a5a" opacity={0.45} />
          </pattern>
        </defs>

        {/* board chassis */}
        <rect x={6} y={6} width={w - 12} height={h - 12} rx={18} fill="#123028" stroke="#0b1f19" strokeWidth={4} />
        <rect x={14} y={14} width={w - 28} height={h - 28} rx={13} fill="#17372d" stroke="#2b5748" strokeWidth={1.5} />
        <rect x={14} y={14} width={w - 28} height={h - 28} rx={13} fill="url(#pcbgrid)" />

        {/* corner mounting screws */}
        {[[26, 26], [w - 26, 26], [26, h - 26], [w - 26, h - 26]].map(([sx, sy], i) => (
          <g key={i} transform={`translate(${sx}, ${sy})`}>
            <circle r={9} fill="#0e2620" stroke="#2b5748" strokeWidth={2} />
            <circle r={5} fill="#2e564a" />
            <line x1={-4} y1={-4} x2={4} y2={4} stroke="#0e2620" strokeWidth={1.6} />
          </g>
        ))}

        <text x={w / 2} y={38} textAnchor="middle" fontSize={12} fill="#8fbdad" fontWeight={800} letterSpacing="0.22em">
          ◄ MAINTENANCE BUS · REV-3 ►
        </text>

        {/* wires (under the parts) */}
        {connectTarget && byId(connectTarget[0]) && byId(connectTarget[1]) && (
          <Wire a={byId(connectTarget[0])!.pos} b={byId(connectTarget[1])!.pos} kind="target" />
        )}
        {world.connected && byId(world.connected[0]) && byId(world.connected[1]) && (
          <Wire a={byId(world.connected[0])!.pos} b={byId(world.connected[1])!.pos} kind="made" />
        )}
        {/* live drag line */}
        {dragFrom && pointer && byId(dragFrom) && (
          <line
            x1={byId(dragFrom)!.pos[0]}
            y1={byId(dragFrom)!.pos[1]}
            x2={pointer[0]}
            y2={pointer[1]}
            stroke="#12897a"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeDasharray="2 7"
            style={{ pointerEvents: "none" }}
          />
        )}
        {/* wrong-attempt flash line */}
        {flash && !flash.correct && byId(flash.from) && byId(flash.to) && (
          <line
            key={flash.key}
            x1={byId(flash.from)!.pos[0]}
            y1={byId(flash.from)!.pos[1]}
            x2={byId(flash.to)!.pos[0]}
            y2={byId(flash.to)!.pos[1]}
            stroke="#d9583a"
            strokeWidth={4}
            strokeLinecap="round"
            className="repair-flash"
            style={{ pointerEvents: "none" }}
          />
        )}

        {world.components.map((c) => {
          const inTarget = connectTarget && (connectTarget[0] === c.id || connectTarget[1] === c.id);
          return (
            <g
              key={c.id}
              transform={`translate(${c.pos[0]}, ${c.pos[1]})`}
              style={{ cursor: draggable ? "grab" : "default" }}
              onPointerDown={(e) => {
                if (!draggable) return;
                e.preventDefault();
                setDragFrom(c.id);
                setPointer(c.pos);
              }}
            >
              {/* module mounting pad — gives each part a mounted, technical look */}
              <rect x={-35} y={-33} width={70} height={66} rx={9} fill="#20463a" stroke="#3a6656" strokeWidth={1.5} />
              {[[-29, -27], [29, -27], [-29, 27], [29, 27]].map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={2} fill="#0e2620" />
              ))}
              {inTarget && <rect x={-38} y={-36} width={76} height={72} rx={11} fill="none" stroke="#e0a53f" strokeWidth={2.5} strokeDasharray="4 5" />}
              {dragFrom === c.id && <rect x={-38} y={-36} width={76} height={72} rx={11} fill="none" stroke="#38c9b5" strokeWidth={2.5} />}
              <Shape shape={c.shape} color={c.color} />
              <circle r={34} fill="transparent" />
              {world.labelled && c.name && (
                <text y={48} textAnchor="middle" fontSize={13} fontWeight={700} fill="#d7e8e1" letterSpacing="0.03em">
                  {c.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
