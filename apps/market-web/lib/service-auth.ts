/**
 * THIRD auth path for market-app's /api/forge surface: SERVICE-KEY ONLY.
 *
 * This is NOT the AuthKit cookie session and NOT the Forge device-auth bearer
 * (`requireForgeUser`) — never conflate the three (CLAUDE.md hard rule #4). It
 * authenticates the web-forge SSR server (NOT a browser, NOT Forge, NOT the Auto
 * worker) so it can resolve an entitled user's licensed package server-to-server
 * for the hosted AgentKitAuto worker path, asserting the user's id WITHOUT the
 * user's live session. Entitlement is STILL enforced downstream — the service
 * key removes only the session requirement.
 *
 * The shared secret lives in MARKET_SERVICE_KEY (server-only; set identically on
 * BOTH market-app and web-forge). It is compared CONSTANT-TIME, never logged, and
 * never shipped to a browser bundle. When the env key is unset the endpoint is
 * DISABLED (503) — it never falls back to unauthenticated access.
 */
import { timingSafeEqual } from "node:crypto";
import { marketServiceAuthHeader } from "@agentkitforge/contracts";

export class ServiceAuthError extends Error {
  /** "unconfigured" → 503 (env key unset); "unauthorized" → 401 (missing/mismatch). */
  readonly code: "unconfigured" | "unauthorized";
  readonly status: number;
  constructor(code: "unconfigured" | "unauthorized", message: string) {
    super(message);
    this.name = "ServiceAuthError";
    this.code = code;
    this.status = code === "unconfigured" ? 503 : 401;
  }
}

/** Constant-time compare. timingSafeEqual throws on differing lengths, so we
 *  reject a length mismatch first (the length itself is not the secret). */
function serviceKeyMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the presented service key from the canonical header OR an
 *  `Authorization: Bearer` fallback (either is accepted). */
function presentedKey(request: Request): string | null {
  const headerKey = request.headers.get(marketServiceAuthHeader);
  if (headerKey && headerKey.length > 0) return headerKey;
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * Gate a request on the shared MARKET_SERVICE_KEY. Throws ServiceAuthError
 * ("unconfigured" → 503 when the env key is unset; "unauthorized" → 401 on a
 * missing/mismatched key). Returns void on success.
 */
export function requireServiceKey(request: Request): void {
  const expected = process.env.MARKET_SERVICE_KEY;
  if (!expected || expected.length === 0) {
    throw new ServiceAuthError("unconfigured", "Service-to-service access is not configured.");
  }
  const presented = presentedKey(request);
  if (!presented || !serviceKeyMatches(expected, presented)) {
    throw new ServiceAuthError("unauthorized", "Invalid or missing service key.");
  }
}
