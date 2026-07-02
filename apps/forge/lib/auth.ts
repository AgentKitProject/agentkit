// Thin re-exports over the SELECTED auth provider (see lib/auth-provider/).
//
// Web Forge is logged-in by design (unlike the local-first desktop app): every
// API route requires an authenticated user, and all KitStore access is scoped
// to that user's id. The concrete backend (WorkOS/AuthKit for the hosted SaaS,
// or a generic OIDC provider for self-hosted) is selected by `AUTH_PROVIDER`;
// the ~40 routes here consume only the abstract `CurrentUser`, so they are
// unaffected by which provider is active.
import { getAuthProvider } from "./auth-provider";
import type { CurrentUser } from "./auth-provider/types";

export type { CurrentUser } from "./auth-provider/types";
export { UnauthorizedError } from "./auth-provider/types";

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return getAuthProvider().getCurrentUser();
}

export async function requireUser(): Promise<CurrentUser> {
  return getAuthProvider().requireUser();
}

// For API routes: throw (handled by withRoute) rather than redirect.
export async function requireUserForApi(): Promise<CurrentUser> {
  return getAuthProvider().requireUserForApi();
}

export function getUserEmail(user?: Pick<CurrentUser, "email"> | null) {
  return user?.email ?? null;
}
