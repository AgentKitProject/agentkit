// Server-side bridge between the browser COOKIE session and the hosted-Market
// client's TokenStore-based auth.
//
// The hosted-Market submit/download flows authenticate to Market's
// `/api/forge/*` routes with a BEARER token (see CLAUDE.md cross-repo
// contract #2/#5). The web user does NOT have a device-auth session; they have a
// browser cookie session. Under both providers we forward a token from that
// session as the Market bearer:
//   - WorkOS: `withAuth()` exposes the WorkOS ACCESS TOKEN.
//   - OIDC (Keycloak): the OIDC iron-session holds the Keycloak ID TOKEN (we do
//     NOT store the access token — that bloated the sealed cookie past the ~4KB
//     limit and broke login; see oidc-config.ts). Market's `requireForgeUser`
//     verifies the forwarded token as a Keycloak JWT purely on signature +
//     issuer + audience + `sub` — it does NOT check the `typ` claim — so an ID
//     token is accepted identically to an access token. The realm must stamp
//     Market's client id into the ID token's `aud` via an Audience mapper on the
//     forge client (`id.token.claim=true`), else Market returns 401.
//
// We wrap that access token in a read-only TokenStore so the core market client
// (`submitKit`, `downloadKit`, `fetchLicensedKit`) can consume it unchanged.
// There is no refresh token here: the cookie session owns refresh, so
// `ensureAccessToken` simply returns the token we seed. A 401 from Market
// surfaces as ReconnectRequiredError, which the route maps to "re-authenticate".
//
// NEVER log the access token.
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { StoredSession, TokenStore } from "@agentkitforge/core/market";
import { getOidcSession } from "@/lib/auth-provider/oidc-session";

function isOidc(): boolean {
  return (process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc";
}

/**
 * Return the current user's access token to forward to hosted Market as the
 * bearer, or null when there is no signed-in session / no token.
 *
 * Under AUTH_PROVIDER=oidc this reads the OIDC iron-session and returns the
 * user's own Keycloak ID token; otherwise it returns the WorkOS access token
 * from the AuthKit cookie session. Callers that gate on a null token degrade
 * gracefully; submit-only paths throw a clean error below. (Name kept as
 * `getWorkosAccessToken` for its many callers; it is provider-agnostic now.)
 */
export async function getWorkosAccessToken(): Promise<string | null> {
  if (isOidc()) {
    // Under OIDC (Keycloak), forward the user's ID token from the Forge
    // iron-session as the Market bearer. We use the ID token (not the access
    // token) because it is already in the session — forwarding it adds ZERO
    // cookie bytes, whereas persisting the access token too overflowed the ~4KB
    // sealed cookie and broke login. Market's requireForgeUser verifies it as a
    // Keycloak JWT (issuer + aud) and does not check `typ`; the realm must stamp
    // Market's client id into the ID token's `aud` via an Audience mapper on the
    // forge client (id.token.claim=true), else Market returns 401.
    try {
      const session = await getOidcSession();
      return session?.idToken ?? null;
    } catch {
      return null;
    }
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
