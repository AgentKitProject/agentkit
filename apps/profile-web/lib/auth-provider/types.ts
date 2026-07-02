// Shared auth-provider abstraction for AgentKitProfile (web tier).
//
// The Profile web app supports a PLUGGABLE authentication backend selected by the
// `AUTH_PROVIDER` env var:
//   - `workos` (default): WorkOS/AuthKit cookie sessions — our hosted SaaS path.
//     Behaviorally identical to the original direct-AuthKit wiring; the logic is
//     just relocated into `workos-provider.ts`.
//   - `oidc`: a generic OpenID Connect provider (Authorization Code + PKCE) for
//     self-hosted instances, with an iron-session sealed cookie.
//
// Pages and API routes consume only the abstract `AgentKitUser` (re-exported via
// lib/auth/session.ts), so they are unaffected by which provider is active. The
// `id` becomes the `x-agentkit-user-id` actor for org CRUD + profile-api calls.
import type { NextFetchEvent, NextRequest } from "next/server";

/**
 * The provider-agnostic authenticated user. This is the SAME shape the Profile
 * app already consumed from WorkOS's `withAuth().user` — pages/routes only read
 * `id`, `email`, `firstName`, `lastName`. The WorkOS provider maps its richer
 * user down to this; the OIDC provider maps ID-token / userinfo claims onto it.
 */
export type AgentKitUser = {
  id: string;
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** Group/role memberships from the IdP (OIDC `groups`/`roles` claims). Lets
   *  self-host admin gating honor an IdP admins group (ADMIN_OIDC_GROUP) in
   *  addition to the email allowlist. Absent on the WorkOS path. */
  groups?: string[] | null;
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
  getCurrentUser(): Promise<AgentKitUser | null>;

  /**
   * Middleware-safe current user: derives the session from `request.cookies`
   * ONLY (edge runtime). Unlike `getCurrentUser()`, it must NOT use `next/headers`
   * `cookies()`. Never throws — returns null when there is no valid cookie session.
   */
  getMiddlewareUser(request: NextRequest): Promise<AgentKitUser | null>;

  /** Current user, redirecting to sign-in when absent (for pages/server comps). */
  requireUser(returnTo?: string): Promise<AgentKitUser>;

  /** GET /auth/sign-in handler: redirect into the provider's authorize flow. */
  handleSignIn(request: NextRequest): Promise<Response>;

  /** GET /auth/callback handler: complete the flow + seal the session. */
  handleCallback(request: NextRequest): Promise<Response>;

  /** GET /auth/sign-out handler: clear the session (+ optional provider logout). */
  handleSignOut(request: NextRequest): Promise<Response>;

  /** Per-request middleware step (silent refresh / session attach). */
  runMiddleware(request: NextRequest, event: NextFetchEvent): Promise<Response | undefined>;
};
