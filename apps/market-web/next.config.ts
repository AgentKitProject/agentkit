import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) for the
  // self-host Docker image (runs `node server.js`). Gated on BUILD_STANDALONE so
  // the hosted Amplify build is unchanged (Amplify manages its own SSR output).
  // Server env (backend URL, WorkOS, admin/profile keys) is read at runtime —
  // nothing is baked at build either way.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // @agentkitforge/ui is a pure-ESM package; Next.js webpack needs transpilePackages
  // to bundle it correctly (avoids static-analysis false-positives and SSR
  // prerender failures caused by module-resolution issues at runtime).
  transpilePackages: ["@agentkitforge/ui"],
  // openid-client/oauth4webapi MUST NOT be bundled by Next. oauth4webapi builds a
  // web ReadableStream/TransformStream while processing the OIDC token response;
  // Next's server bundling mangles it, throwing
  // `controller[kState].transformAlgorithm is not a function` inside
  // authorizationCodeGrant at runtime (the OIDC callback then 401s). Keeping these
  // external loads the real npm package at runtime (verified working), which Next's
  // standalone output traces into .next/standalone/node_modules.
  serverExternalPackages: ["openid-client", "oauth4webapi"],
};

export default nextConfig;
