// Apply generated SQL migrations to the configured database.
//   pglite → drizzle-orm/pglite/migrator
//   neon   → drizzle-orm/neon-http/migrator
//
// Run: npm run db:generate  (writes ./drizzle/*.sql from schema.ts)
//      npm run db:migrate   (applies them)

import "dotenv/config";
import { join } from "node:path";
import { env } from "@/lib/env";
import * as schema from "@/lib/db/schema";

const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle");

async function main() {
  const e = env();
  if (e.DB_DRIVER === "neon") {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    const db = drizzle(neon(e.DATABASE_URL!), { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("✓ migrated (neon)");
    return;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const pg = new PGlite(e.PGLITE_DATA_DIR);
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await pg.close();
  console.log(`✓ migrated (pglite @ ${e.PGLITE_DATA_DIR})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
