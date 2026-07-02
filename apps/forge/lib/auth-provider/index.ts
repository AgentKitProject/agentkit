// Auth-provider selector. Picks the implementation from `AUTH_PROVIDER`:
//   - unset | "workos" → WorkOS/AuthKit (hosted SaaS; default).
//   - "oidc"           → generic OpenID Connect (self-hosted).
//
// `lib/auth.ts` re-exports thin wrappers over the selected provider so the ~40
// API routes that consume `CurrentUser` keep working unchanged.
import { oidcProvider } from "./oidc-provider";
import { workosProvider } from "./workos-provider";
import type { AuthProvider } from "./types";

export type AuthProviderId = "workos" | "oidc";

export function resolveAuthProviderId(env: NodeJS.ProcessEnv = process.env): AuthProviderId {
  const raw = (env.AUTH_PROVIDER ?? "").trim().toLowerCase();
  return raw === "oidc" ? "oidc" : "workos";
}

export function getAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  return resolveAuthProviderId(env) === "oidc" ? oidcProvider : workosProvider;
}

/** True when the active provider is OIDC (self-hosted). */
export function isOidcProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAuthProviderId(env) === "oidc";
}

export type { AuthProvider, CurrentUser } from "./types";
export { UnauthorizedError } from "./types";
