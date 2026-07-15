// ─────────────────────────────────────────────────────────────────────────────
// Public study config for the Prolific entry gate (§8): consent copy, the
// attention question (WITHOUT the answer), whether Prolific params are required,
// and the completion / screen-out redirect URLs (code baked in from env).
//
// The attention answer never leaves the server — it's checked by verifyAttention.
// ─────────────────────────────────────────────────────────────────────────────

import { env } from "@/lib/env";
import { loadProlificConfig } from "@/lib/config";

export interface PublicStudyConfig {
  requireProlific: boolean;
  consent: {
    title: string;
    sections: Array<{ h?: string; p: string }>;
    dataSharing: { question: string };
    agreeLabel: string;
    declineLabel: string;
  };
  completeUrl: string;
  screenoutUrl: string;
}

export function getPublicStudyConfig(): PublicStudyConfig {
  const cfg = loadProlificConfig();
  const e = env();
  const url = (code: string) => `${e.PROLIFIC_COMPLETE_BASE}?cc=${encodeURIComponent(code)}`;
  return {
    // Only enforced in production, so local dev can exercise the flow without params.
    requireProlific: cfg.requireProlificParams && process.env.NODE_ENV === "production",
    consent: cfg.consent,
    completeUrl: url(e.PROLIFIC_COMPLETION_CODE),
    screenoutUrl: url(e.PROLIFIC_SCREENOUT_CODE),
  };
}
