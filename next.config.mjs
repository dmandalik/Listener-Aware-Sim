/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PGlite ships a wasm build; keep it external to the server bundle so Next
  // doesn't try to bundle the .wasm. Harmless when we run on Neon in prod.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Force the Drizzle migration folder into the serverless function bundle so
  // ensureMigrated() can read drizzle/meta/_journal.json + the .sql files at
  // runtime on Vercel (they're plain files Next wouldn't otherwise trace).
  outputFileTracingIncludes: {
    "/api/**": ["./drizzle/**/*"],
  },
};

export default nextConfig;
