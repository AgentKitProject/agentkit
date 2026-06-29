// Instance-level "require login" gate for self-hosted Market.
//
// By DEFAULT (env unset / anything but "true") the Market catalog is PUBLIC —
// the hosted marketplace is unaffected. When an operator sets REQUIRE_LOGIN=true
// (e.g. an internet-facing self-host that should be private), EVERY request must
// carry an authenticated cookie session or it is sent to sign-in (pages) / 401'd
// (API).
//
// This gate is for the COOKIE-session browser surface ONLY. The device-bearer
// (`/api/forge/*`) and service-key (`/api/forge/service/*`) routes own their own
// auth (CLAUDE.md hard rule #4) and are EXEMPT here so the gate never conflates
// the three auth paths. `/auth/*` is exempt so a user can actually log in, and
// the health route is exempt so k8s probes work regardless of this setting.
//
// The decision logic is a PURE function (`requireLoginGateDecision`) so it can be
// unit-tested without the Next.js runtime; `requireLoginEnabled()` mirrors the
// existing `SELF_HOST` env pattern in `lib/forge-link.ts`.

/** True only when REQUIRE_LOGIN is exactly "true" (case/space-insensitive). */
export function requireLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.REQUIRE_LOGIN ?? "").trim().toLowerCase() === "true";
}

/**
 * Path prefixes that are NEVER gated, even when REQUIRE_LOGIN=true:
 *  - `/auth/`               sign-in / callback / sign-out — required to log in.
 *  - `/api/forge/`          Forge device-bearer auth (its own path). This prefix
 *                           also covers `/api/forge/service/` (service key).
 *  - `/healthz`             liveness/readiness probe — must return 200 unauthed.
 *
 * Static assets (`_next/static`, `_next/image`, `favicon.ico`, `brand/`) are
 * already excluded by the middleware `matcher`, so they never reach this gate.
 */
export const REQUIRE_LOGIN_EXEMPT_PREFIXES = ["/auth/", "/api/forge/", "/healthz"] as const;

/** True when `pathname` is exempt from the require-login gate. */
export function isRequireLoginExemptPath(pathname: string): boolean {
  return REQUIRE_LOGIN_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix)
  );
}

export type RequireLoginGateAction = "allow" | "redirect" | "unauthorized";

/**
 * Pure gate decision. Inputs are the only things the middleware needs to know:
 * whether the gate is enabled, the request pathname, and whether the request is
 * already authenticated (a cookie session was found).
 *
 *  - gate off                       → "allow" (public — today's behavior).
 *  - exempt path                    → "allow".
 *  - authenticated                  → "allow".
 *  - unauthenticated + `/api/*`     → "unauthorized" (401 JSON).
 *  - unauthenticated + page         → "redirect" (to sign-in with returnTo).
 */
export function requireLoginGateDecision(input: {
  enabled: boolean;
  pathname: string;
  authenticated: boolean;
}): RequireLoginGateAction {
  const { enabled, pathname, authenticated } = input;
  if (!enabled) {
    return "allow";
  }
  if (isRequireLoginExemptPath(pathname)) {
    return "allow";
  }
  if (authenticated) {
    return "allow";
  }
  return pathname.startsWith("/api/") ? "unauthorized" : "redirect";
}
