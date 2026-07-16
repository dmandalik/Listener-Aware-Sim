// Board avatars: the human helper (retrieval) and the robot (teleop) that stand in
// for the player's position on the grid. A step up from a plain dot so the two
// roles read at a glance, styled to match the app's robot (teal head, white
// outline, gold antenna). Sized to the caller's cell; positioning is the board's job.

export function HumanToken({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="you (the helper)"
      style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(11,95,84,0.45))" }}
    >
      {/* head */}
      <circle cx="12" cy="7" r="4" fill="#12897a" stroke="#fff" strokeWidth="1.4" />
      {/* torso / shoulders */}
      <path
        d="M12 12.2c-4.2 0-7 2.6-7 6.2 0 .6.5 1.1 1.1 1.1h11.8c.6 0 1.1-.5 1.1-1.1 0-3.6-2.8-6.2-7-6.2z"
        fill="#12897a"
        stroke="#fff"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function RobotToken({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="the robot"
      style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(11,95,84,0.45))" }}
    >
      {/* antenna */}
      <line x1="12" y1="1.4" x2="12" y2="4.6" stroke="#0b5f54" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="1.6" r="1.5" fill="#e0a53f" />
      {/* head */}
      <rect x="3.5" y="4.5" width="17" height="14" rx="4.5" fill="#12897a" stroke="#fff" strokeWidth="1.4" />
      {/* face plate */}
      <rect x="6.6" y="7.6" width="10.8" height="7.8" rx="2.6" fill="#eafaf6" />
      {/* eyes */}
      <circle cx="9.7" cy="11.5" r="1.35" fill="#0b5f54" />
      <circle cx="14.3" cy="11.5" r="1.35" fill="#0b5f54" />
    </svg>
  );
}
