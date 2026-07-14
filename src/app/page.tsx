import Link from "next/link";
import { RobotAvatar } from "@/components/RobotAvatar";

export default function Home() {
  return (
    <main className="center-screen">
      <div className="card" style={{ padding: 36, width: "min(560px, 94vw)", textAlign: "center" }}>
        <div style={{ display: "grid", placeItems: "center", marginBottom: 8 }}>
          <RobotAvatar mood="hopeful" size={92} />
        </div>
        <div className="eyebrow">The Fetch Games</div>
        <h1 style={{ margin: "6px 0 10px", fontSize: 30 }}>A robot needs your help.</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 16, lineHeight: 1.5, margin: "0 auto 24px", maxWidth: 420 }}>
          It knows what it needs but can&rsquo;t reach it. You can move, but you can only see
          the room you&rsquo;re standing in. It gets <b>one</b> message to guide you. Listen
          carefully.
        </p>
        <Link href="/listener" className="btn" style={{ display: "inline-block", textDecoration: "none" }}>
          Start the mission →
        </Link>
        <p style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 18 }}>
          Desktop &amp; keyboard recommended.
        </p>
      </div>
    </main>
  );
}
