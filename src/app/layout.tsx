import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Listener Aware Project Simulation",
  description: "A robot needs your help. Can you fetch what it means?",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
