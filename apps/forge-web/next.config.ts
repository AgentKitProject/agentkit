import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) for the
  // self-host Docker image (runs `node server.js`). Gated on BUILD_STANDALONE so
  // a hosted Amplify build is unchanged (Amplify manages its own SSR output).
  // Server env (WorkOS, data dir, AI keys, Market base URL) is read at runtime —
  // nothing is baked at build either way. Mirrors agentkitmarket-app.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),

  // @agentkitforge/core is Node-only (fs, child_process). Keep it external to
  // the server bundle so its native/Node deps resolve at runtime, and ensure it
  // is NEVER pulled into a client bundle.
  // AWS SDK + pg are Node-only cloud-adapter deps, loaded only when
  // KITSTORE_BACKEND=aws|selfhost. Keep them external so they resolve at runtime
  // in the server (and standalone) output and are never bundled client-side.
  // openid-client/oauth4webapi MUST stay external: oauth4webapi builds a web
  // ReadableStream/TransformStream while processing the OIDC token response, and
  // Next's server bundling mangles it → `controller[kState].transformAlgorithm is
  // not a function` inside authorizationCodeGrant at runtime (OIDC callback 401s).
  // Loading the real npm package at runtime avoids it. (Verified against a live
  // OIDC IdP on the self-host k3s path.)
  serverExternalPackages: [
    "@agentkitforge/core",
    "jszip",
    "@aws-sdk/client-s3",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "pg",
    "openid-client",
    "oauth4webapi"
  ]
};

export default nextConfig;
