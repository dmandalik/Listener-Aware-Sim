import { defineConfig } from "drizzle-kit";

// We generate portable Postgres SQL migrations from schema.ts. They apply to both
// PGlite (local) and Neon (prod) via the runtime migrator in scripts/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
});
