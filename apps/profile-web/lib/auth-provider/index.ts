// Auth-provider selector. Picks the implementation from `AUTH_PROVIDER`:
//   - unset | "workos" → WorkOS/AuthKit (hosted SaaS; default).
//   - "oidc"           → generic OpenID Connect (self-hosted).
//
// `lib/auth/session.ts` re-exports thin wrappers over the selected provider so
// the pages / API routes that consume `AgentKitUser` keep working unchanged.
//
// Providers are loaded LAZILY (dynamic import) so that selecting OIDC never
// pulls in `@workos-inc/authkit-nextjs`, and unit tests can import the pure
// selector / claim-mapping helpers without loading either provider's deps.
import type { AuthProvider } from "./types.ts";

export type AuthProviderId = "workos" | "oidc";

export function resolveAuthProviderId(env: NodeJS.ProcessEnv = process.env): AuthProviderId {
  const raw = (env.AUTH_PROVIDER ?? "").trim().toLowerCase();
  return raw === "oidc" ? "oidc" : "workos";
}

/** True when the active provider is OIDC (self-hosted). */
export function isOidcProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAuthProviderId(env) === "oidc";
}

export async function getAuthProvider(env: NodeJS.ProcessEnv = process.env): Promise<AuthProvider> {
  if (resolveAuthProviderId(env) === "oidc") {
    const { oidcProvider } = await import("./oidc-provider.ts");
    return oidcProvider;
  }
  const { workosProvider } = await import("./workos-provider.ts");
  return workosProvider;
}

export type { AuthProvider, AgentKitUser } from "./types.ts";
export { UnauthorizedError } from "./types.ts";
