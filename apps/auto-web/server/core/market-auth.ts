// Server-side bridge between the AuthKit COOKIE session and the hosted-Market
// client's TokenStore-based auth.
//
// The hosted-Market submit/download flows authenticate to Market's
// `/api/forge/*` routes with a WorkOS BEARER access token (see CLAUDE.md
// cross-repo contract #2/#5). The web user does NOT have a device-auth session;
// they have an AuthKit cookie session. `withAuth()` exposes the underlying
// WorkOS ACCESS TOKEN, which is exactly the bearer token Market expects.
//
// We wrap that access token in a read-only TokenStore so the core market client
// (`submitKit`, `downloadKit`, `fetchLicensedKit`) can consume it unchanged.
// There is no refresh token here: the AuthKit cookie session owns refresh, so
// `ensureAccessToken` simply returns the token we seed. A 401 from Market
// surfaces as ReconnectRequiredError, which the route maps to "re-authenticate".
//
// NEVER log the access token.
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { StoredSession, TokenStore } from "@agentkitforge/core/market";

/**
 * Return the current user's WorkOS access token from the AuthKit cookie
 * session, or null when there is no signed-in session / no token.
 */
export async function getWorkosAccessToken(): Promise<string | null> {
  // Under self-hosted OIDC there is no WorkOS access token (the session is an
  // iron-session, not an AuthKit cookie) and hosted Market is off, so this seam
  // is inert: return null without touching `withAuth()`. Hosted (workos) is
  // unchanged. Mirrors agentkitforge.
  if ((process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc") {
    return null;
  }
  try {
    const auth = await withAuth();
    return auth.user ? auth.accessToken ?? null : null;
  } catch {
    return null;
  }
}

/**
 * A TokenStore seeded with the current user's WorkOS access token. `get()`
 * always reflects the live cookie-session token; `set`/`clear` are no-ops
 * because the cookie session (not this store) owns the token lifecycle.
 *
 * Throws when there is no access token so Market calls fail loudly rather than
 * silently dropping auth.
 */
export async function createSessionTokenStore(): Promise<TokenStore> {
  const accessToken = await getWorkosAccessToken();
  if (!accessToken) {
    throw new Error("A signed-in AgentKitProject session is required for hosted-Market operations.");
  }
  const session: StoredSession = { accessToken, connectedAt: new Date().toISOString() };
  return {
    async get() {
      // Re-read the live token each call in case the session was refreshed.
      const fresh = await getWorkosAccessToken();
      return fresh ? { ...session, accessToken: fresh } : session;
    },
    async set() {
      /* cookie session owns the token lifecycle */
    },
    async clear() {
      /* cookie session owns the token lifecycle */
    }
  };
}

/** The WorkOS client id used to talk to hosted Market (see CLAUDE.md #2). */
export function workosClientId(): string {
  return process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID ?? "";
}
