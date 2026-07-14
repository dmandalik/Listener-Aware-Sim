// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — database client (dual driver)
//
//   DB_DRIVER=pglite → embedded in-process Postgres (local dev, tests, headless
//                      engine). No server, no Docker. Data at PGLITE_DATA_DIR.
//   DB_DRIVER=neon   → Neon serverless Postgres (production).
//
// Same Drizzle schema and query surface for both, so code written against `db`
// runs identically in dev and prod.
//
// Note: `drizzle-orm/pglite` and `drizzle-orm/neon-http` return the same Drizzle
// query API; we widen to a shared type so callers don't branch on the driver.
// ─────────────────────────────────────────────────────────────────────────────

import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = {
  // Structural: both drivers expose the Drizzle query builder methods we use.
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (...args: any[]) => any;
  query: any;
  $client?: unknown;
};

type Handle = { db: Db; driver: "pglite" | "neon"; pglite?: unknown };

// Module-level singleton. In Next serverless this is reused within a warm
// instance; a cold start makes a fresh one. PGlite dev data is file-backed so it
// survives restarts.
let handle: Handle | null = null;

async function create(): Promise<Handle> {
  const e = env();
  if (e.DB_DRIVER === "neon") {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const sql = neon(e.DATABASE_URL!);
    const db = drizzle(sql, { schema }) as unknown as Db;
    return { db, driver: "neon" };
  }
  // pglite
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const pg = new PGlite(e.PGLITE_DATA_DIR);
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { db, driver: "pglite", pglite: pg };
}

export async function getDb(): Promise<Db> {
  if (!handle) handle = await create();
  return handle.db;
}

// Apply migrations once per warm instance. Drizzle's migrators are idempotent
// (they track applied migrations), so this is safe to await on every request; it
// makes local dev seamless (no manual migrate step) and prod safe on deploy.
let migrated: Promise<void> | null = null;
export function ensureMigrated(): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      const { join } = await import("node:path");
      const folder = join(process.cwd(), "drizzle");
      const h = await getHandle();
      if (h.driver === "neon") {
        const { migrate } = await import("drizzle-orm/neon-http/migrator");
        await migrate(h.db as any, { migrationsFolder: folder });
      } else {
        const { migrate } = await import("drizzle-orm/pglite/migrator");
        await migrate(h.db as any, { migrationsFolder: folder });
      }
    })();
  }
  return migrated;
}

/** Full handle — needed by the migration runner (raw PGlite access). */
export async function getHandle(): Promise<Handle> {
  if (!handle) handle = await create();
  return handle;
}

export { schema };
