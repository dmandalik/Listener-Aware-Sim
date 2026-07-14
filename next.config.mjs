/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PGlite ships a wasm build; keep it external to the server bundle so Next
  // doesn't try to bundle the .wasm. Harmless when we run on Neon in prod.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
