// Shared auth-provider abstraction for Web Forge.
//
// Web Forge supports a PLUGGABLE authentication backend selected by the
// `AUTH_PROVIDER` env var:
//   - `workos` (default): WorkOS/AuthKit cookie sessions — our hosted SaaS path.
//     Behaviorally identical to the original direct-AuthKit wiring; the logic is
//     just relocated into `workos-provider.ts`.
//   - `oidc`: a generic OpenID Connect provider (Authorization Code + PKCE) for
//     self-hosted instances, with an iron-session sealed cookie.
//
// All ~40 API routes consume only the abstract `CurrentUser` (re-exported via
// lib/auth.ts), so they are unaffected by which provider is active.
import type { NextFetchEvent, NextRequest } from "next/server";

export type CurrentUser = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * The provider contract. Each backend (WorkOS, OIDC) implements this; the
 * selected impl is wired up in `lib/auth-provider/index.ts`.
 */
export type AuthProvider = {
  /** The provider id, for diagnostics / capability checks. */
  readonly id: "workos" | "oidc";

  /** Current user from the session cookie, or null. Never throws. */
  getCurrentUser(): Promise<CurrentUser | null>;

  /** Current user, redirecting to sign-in when absent (for pages/server comps). */
  requireUser(): Promise<CurrentUser>;

  /** Current user, throwing UnauthorizedError when absent (for API routes). */
  requireUserForApi(): Promise<CurrentUser>;

  /** Build the URL the /forge gate / sign-in route should redirect users to. */
  getSignInUrl(): Promise<string>;

  /** GET /auth/sign-in handler: redirect into the provider's authorize flow. */
  handleSignIn(request: NextRequest): Promise<Response>;

  /** GET /auth/callback handler: complete the flow + seal the session. */
  handleCallback(request: NextRequest): Promise<Response>;

  /** GET /auth/sign-out handler: clear the session (+ optional provider logout). */
  handleSignOut(request: NextRequest): Promise<Response>;

  /** Per-request middleware step (silent refresh / session attach). */
  runMiddleware(request: NextRequest, event: NextFetchEvent): Promise<Response | undefined>;
};
