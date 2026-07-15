// A small expressive robot. It has failed and is asking for help; a few states
// change how the whole task feels for almost no cost (§11).

export type RobotMood = "waiting" | "hopeful" | "thanking" | "sad";

export function RobotAvatar({
  mood = "waiting",
  size = 56,
}: {
  mood?: RobotMood;
  size?: number;
}) {
  const eye = mood === "sad" ? "#d9583a" : "#0b5f54";
  // Small mouth, sitting inside the face plate (below the eyes). A gentle smile
  // by default; a bigger smile when thanking; a frown only when sad.
  const mouth =
    mood === "thanking"
      ? "M23 33 Q28 38 33 33" // happy smile
      : mood === "sad"
        ? "M24 35 Q28 32 32 35" // frown
        : "M24 34 Q28 37 32 34"; // gentle smile (waiting / hopeful / default)

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 56 56"
      role="img"
      aria-label={`robot ${mood}`}
      style={{ display: "block" }}
    >
      {/* antenna */}
      <line x1="28" y1="6" x2="28" y2="13" stroke="#0b5f54" strokeWidth="2" />
      <circle cx="28" cy="5" r="3" fill="#e0a53f">
        {mood === "hopeful" && (
          <animate attributeName="r" values="3;4;3" dur="1.1s" repeatCount="indefinite" />
        )}
      </circle>
      {/* head */}
      <rect x="9" y="13" width="38" height="32" rx="9" fill="#12897a" />
      <rect x="9" y="13" width="38" height="32" rx="9" fill="none" stroke="#0b5f54" strokeWidth="2" />
      {/* face plate */}
      <rect x="14" y="19" width="28" height="20" rx="6" fill="#eafaf6" />
      {/* eyes */}
      <circle cx="22" cy="26" r="2.7" fill={eye}>
        {mood === "waiting" && (
          <animate
            attributeName="ry"
            values="2.7;0.6;2.7"
            dur="3.2s"
            keyTimes="0;0.06;0.12"
            repeatCount="indefinite"
          />
        )}
      </circle>
      <circle cx="34" cy="26" r="2.7" fill={eye}>
        {mood === "waiting" && (
          <animate
            attributeName="ry"
            values="2.7;0.6;2.7"
            dur="3.2s"
            keyTimes="0;0.06;0.12"
            repeatCount="indefinite"
          />
        )}
      </circle>
      {/* mouth */}
      <path d={mouth} fill="none" stroke={eye} strokeWidth="2" strokeLinecap="round" />
      {/* ears */}
      <rect x="5" y="24" width="4" height="10" rx="2" fill="#0b5f54" />
      <rect x="47" y="24" width="4" height="10" rx="2" fill="#0b5f54" />
    </svg>
  );
}
