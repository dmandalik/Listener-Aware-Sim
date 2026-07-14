// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — environment loading, validated and FAIL-LOUD (§13, §15)
//
// A missing/invalid required var throws at startup with a clear message rather
// than letting the app run half-configured. Never "silently proceed".
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

const zEnv = z
  .object({
    DB_DRIVER: z.enum(["pglite", "neon"]).default("pglite"),
    DATABASE_URL: z.string().optional(),
    PGLITE_DATA_DIR: z.string().default("./.pglite"),

    ADMIN_SECRET: z.string().min(1).default("change-me-in-prod"),

    PROLIFIC_COMPLETION_CODE: z.string().default("CHANGME_COMPLETE"),
    PROLIFIC_SCREENOUT_CODE: z.string().default("CHANGME_SCREENOUT"),
  })
  .superRefine((v, ctx) => {
    if (v.DB_DRIVER === "neon" && !v.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when DB_DRIVER=neon",
      });
    }
  });

export type Env = z.infer<typeof zEnv>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = zEnv.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${detail}\n` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  cached = parsed.data;
  return cached;
}
