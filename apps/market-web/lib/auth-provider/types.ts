// Shared auth-provider abstraction for AgentKitMarket (web tier).
//
// The Market web app supports a PLUGGABLE authentication backend selected by the
// `AUTH_PROVIDER` env var:
//   - `workos` (default): WorkOS/AuthKit cookie sessions — our hosted SaaS path.
//     Behaviorally identical to the original direct-AuthKit wiring; the logic is
//     just relocated into `workos-provider.ts`.
//   - `oidc`: a generic OpenID Connect provider (Authorization Code + PKCE) for
//     self-hosted instances, with an iron-session sealed cookie.
//
// Browser API routes (`/api/submissions/*`, `/api/kits/*`, `/api/admin/*`),
// pages, and the layout consume only the abstract `CurrentUser` (re-exported via
// lib/auth.ts), so they are unaffected by which provider is active.
//
// NOTE: the device-bearer path (`/api/forge/*`, `requireForgeUser`) is a SEPARATE
// auth path (CLAUDE.md hard rule #4) and is NOT part of this interface; it is
// WorkOS-bound and made inert (501) under AUTH_PROVIDER=oidc in lib/forge-auth.ts.
import type { NextFetchEvent, NextRequest } from "next/server";
import type { AgentKitMarketRole } from "@/lib/permissions";

export type CurrentUser = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: AgentKitMarketRole;
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

  /**
   * Middleware-safe current user: derives the session from `request.cookies`
   * ONLY (edge runtime). Unlike `getCurrentUser()`, it must NOT use `next/headers`
   * `cookies()` (which only works in server components / route handlers). Used by
   * the instance-level require-login gate in `middleware.ts`. Never throws —
   * returns null when there is no valid cookie session.
   */
  getMiddlewareUser(request: NextRequest): Promise<CurrentUser | null>;

  /** Current user, redirecting to sign-in when absent (for pages/server comps). */
  requireUser(): Promise<CurrentUser>;

  /** Current user, throwing UnauthorizedError when absent (for API routes). */
  requireUserForApi(): Promise<CurrentUser>;

  /** GET /auth/sign-in handler: redirect into the provider's authorize flow. */
  handleSignIn(request: NextRequest): Promise<Response>;

  /** GET /auth/callback handler: complete the flow + seal the session. */
  handleCallback(request: NextRequest): Promise<Response>;

  /** GET /auth/sign-out handler: clear the session (+ optional provider logout). */
  handleSignOut(request: NextRequest): Promise<Response>;

  /** Per-request middleware step (silent refresh / session attach). */
  runMiddleware(request: NextRequest, event: NextFetchEvent): Promise<Response | undefined>;
};
