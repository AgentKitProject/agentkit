// Generic OIDC provider — the SELF-HOSTED path (AUTH_PROVIDER=oidc).
//
// Authorization Code + PKCE via `openid-client` (v6 functional API), with an
// iron-session sealed cookie holding the mapped AgentKitUser + OIDC tokens.
// Mirrors the WorkOS provider's interface so the pages, account routes, and the
// org API routes are unaffected.
//
// First-login provisioning is LAZY (same as the WorkOS path): the profile-api
// creates the profile from the trusted-context headers (x-agentkit-user-id /
// -email) on the first authenticated /me call, deriving the display name from
// the identity. So this provider only has to populate id/email/name onto the
// AgentKitUser; provisioning happens downstream with no extra hook here.
//
// Flow:
//   /auth/sign-in  → generate PKCE verifier + state (short-lived httpOnly
//                    cookies), redirect to the issuer's authorize URL.
//   /auth/callback → exchange the code (verifying state + PKCE), fetch userinfo,
//                    map claims → AgentKitUser, seal the iron-session, redirect.
//   /auth/sign-out → destroy the iron-session (+ optional RP-initiated logout).
//   middleware     → proactively refresh the access token via the refresh token.
import * as oidc from "openid-client";
import { redirect } from "next/navigation";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAppHomeUrl, getAppUrl, safeReturnTo } from "@/lib/auth/urls";
import {
  buildSessionFromTokens,
  getOidcConfig,
  getOidcRedirectUri,
  getOidcScopes,
  mapOidcClaims,
  OIDC_PKCE_COOKIE,
  OIDC_STATE_COOKIE
} from "./oidc-config.ts";
import { getOidcSession, unsealOidcSessionCookie } from "./oidc-session.ts";
import { type AgentKitUser, type AuthProvider } from "./types.ts";

// Refresh when the access token is within this window of expiry.
const REFRESH_SKEW_MS = 60_000;
const TX_COOKIE_MAX_AGE = 600; // 10 min for the in-flight auth transaction.

async function getCurrentUser(): Promise<AgentKitUser | null> {
  try {
    const session = await getOidcSession();
    return session.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Middleware-safe: unseal the iron-session cookie straight from `request.cookies`
 * (no `next/headers`), returning the stored user or null. Never throws.
 */
async function getMiddlewareUser(request: NextRequest): Promise<AgentKitUser | null> {
  const session = await unsealOidcSessionCookie(request);
  return session?.user ?? null;
}

async function requireUser(returnTo?: string): Promise<AgentKitUser> {
  const user = await getCurrentUser();
  if (!user) {
    const returnPath = safeReturnTo(returnTo);
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(returnPath)}`);
  }
  return user;
}

async function handleSignIn(request: NextRequest): Promise<Response> {
  const config = await getOidcConfig();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();

  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: getOidcRedirectUri(),
    scope: getOidcScopes(),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });

  const response = NextResponse.redirect(authUrl.href);
  const secure = process.env.NODE_ENV === "production";
  // Carry the post-login destination across the round-trip via the state cookie's
  // sibling: pack returnTo into the same short-lived transaction window.
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  response.cookies.set(OIDC_PKCE_COOKIE, codeVerifier, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: TX_COOKIE_MAX_AGE
  });
  response.cookies.set(OIDC_STATE_COOKIE, `${state}|${returnTo}`, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: TX_COOKIE_MAX_AGE
  });
  return response;
}

async function handleCallback(request: NextRequest): Promise<Response> {
  const config = await getOidcConfig();
  const codeVerifier = request.cookies.get(OIDC_PKCE_COOKIE)?.value;
  const rawState = request.cookies.get(OIDC_STATE_COOKIE)?.value;

  if (!codeVerifier || !rawState) {
    return new Response("OIDC authentication transaction expired or missing.", { status: 400 });
  }

  const [expectedState, packedReturnTo] = rawState.split("|");
  const returnTo = safeReturnTo(packedReturnTo ?? null);

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    // The current URL must use the configured redirect_uri origin so the
    // library can match it; rebuild from the canonical redirect URI + query.
    const currentUrl = new URL(getOidcRedirectUri());
    currentUrl.search = new URL(request.url).search;
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState
    });
  } catch {
    return new Response("OIDC authentication failed.", { status: 401 });
  }

  // Prefer ID-token claims; enrich with userinfo when a sub is available.
  let claims: Record<string, unknown> = (tokens.claims() as Record<string, unknown>) ?? {};
  const sub = typeof claims.sub === "string" ? claims.sub : undefined;
  if (sub) {
    try {
      const info = await oidc.fetchUserInfo(config, tokens.access_token, sub);
      claims = { ...claims, ...(info as Record<string, unknown>) };
    } catch {
      // userinfo is optional — fall back to ID-token claims.
    }
  }

  const user = mapOidcClaims(claims);
  if (!user.id) {
    return new Response("OIDC token is missing a subject (sub) claim.", { status: 401 });
  }

  const session = await getOidcSession();
  Object.assign(session, buildSessionFromTokens(user, tokens));
  await session.save();

  const response = NextResponse.redirect(new URL(returnTo, getAppUrl()).href);
  response.cookies.delete(OIDC_PKCE_COOKIE);
  response.cookies.delete(OIDC_STATE_COOKIE);
  return response;
}

async function handleSignOut(): Promise<Response> {
  const session = await getOidcSession();
  const idToken = session.idToken;
  session.destroy();

  // Optional RP-initiated logout when the issuer advertises an end-session
  // endpoint; otherwise just clear the local session and return home.
  let target = getAppHomeUrl();
  try {
    const config = await getOidcConfig();
    const meta = config.serverMetadata();
    if (meta.end_session_endpoint) {
      const url = new URL(meta.end_session_endpoint);
      if (idToken) {
        url.searchParams.set("id_token_hint", idToken);
      }
      url.searchParams.set("post_logout_redirect_uri", getAppHomeUrl());
      target = url.href;
    }
  } catch {
    // Discovery failure → fall back to local sign-out only.
  }

  return NextResponse.redirect(target);
}

async function runMiddleware(
  _request: NextRequest,
  _event: NextFetchEvent
): Promise<Response | undefined> {
  // Only attempt silent refresh; never force cookie auth here (the page/API
  // gates own access decisions).
  if (!hasOidcEnv()) {
    return undefined;
  }
  try {
    const session = await getOidcSession();
    if (!session.user || !session.refreshToken || !session.expiresAt) {
      return undefined;
    }
    if (Date.now() < session.expiresAt - REFRESH_SKEW_MS) {
      return undefined;
    }
    const config = await getOidcConfig();
    const priorRefreshToken = session.refreshToken;
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken);
    Object.assign(session, buildSessionFromTokens(session.user, tokens));
    // Preserve the prior refresh token if the IdP didn't rotate one.
    if (!tokens.refresh_token) {
      session.refreshToken = priorRefreshToken;
    }
    await session.save();
  } catch {
    // A failed refresh shouldn't 500 the request; the next gate will redirect.
  }
  return undefined;
}

function hasOidcEnv(): boolean {
  return Boolean(
    process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET
  );
}

export const oidcProvider: AuthProvider = {
  id: "oidc",
  getCurrentUser,
  getMiddlewareUser,
  requireUser,
  handleSignIn,
  handleCallback,
  handleSignOut,
  runMiddleware
};
