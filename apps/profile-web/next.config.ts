import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) for the
  // self-host Docker image (runs `node server.js`). Gated on BUILD_STANDALONE so
  // the hosted Amplify build is unchanged (Amplify manages its own SSR output).
  // Server env (DATABASE_URL, WorkOS, service keys) is read at runtime —
  // nothing is baked at build either way.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // @agentkitforge/ui is a pure-ESM package; Next.js webpack needs transpilePackages
  // to bundle it correctly (avoids static-analysis false-positives and SSR
  // prerender failures caused by module-resolution issues at runtime).
  transpilePackages: ["@agentkitforge/ui"],
  // pg (the Postgres driver) MUST NOT be bundled by Next. It loads native/optional
  // bindings and resolves modules at runtime; Next's server bundling breaks that.
  // Keeping it external loads the real npm package at runtime, which Next's
  // standalone output traces into .next/standalone/node_modules/pg — also making
  // the driver available to the migration Job (scripts/migrate.mts).
  serverExternalPackages: ["pg"],
};

export default nextConfig;
