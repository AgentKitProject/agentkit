// Instance-level "require login" gate for self-hosted Market.
//
// DEFAULTS by deployment type (overridable):
//   - HOSTED (public marketplace): PUBLIC catalog — browse without sign-in.
//   - SELF-HOST (SELF_HOST=true): PRIVATE by default — a self-hosted Market
//     should never be open to anonymous users just because the operator didn't
//     set a flag.
// An explicit REQUIRE_LOGIN always wins: "true" forces private (even hosted),
// "false" forces public (even self-host). When private, EVERY request must carry
// an authenticated cookie session or it is sent to sign-in (pages) / 401'd (API).

// Self-host signal — kept inline (not imported from ./self-host) so this module
// stays dependency-free for the bare `node --test` runner. Mirrors
// lib/self-host.ts isSelfHost: the explicit SELF_HOST flag only (OIDC is just an
// auth mechanism usable by both hosted and self-host, so it does NOT imply
// self-host).
function isSelfHostEnv(env: NodeJS.ProcessEnv): boolean {
  const v = (env.SELF_HOST ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
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

/**
 * Whether the require-login gate is active. Explicit REQUIRE_LOGIN wins
 * ("true"/"false"); when unset, defaults ON for self-host (never run an open
 * self-hosted Market) and OFF for the hosted public catalog.
 */
export function requireLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.REQUIRE_LOGIN ?? "").trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return isSelfHostEnv(env);
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
