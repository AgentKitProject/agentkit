// Generic OIDC provider — the SELF-HOSTED path (AUTH_PROVIDER=oidc).
//
// Authorization Code + PKCE via `openid-client` (v6 functional API), with an
// iron-session sealed cookie holding the mapped CurrentUser + OIDC tokens.
// Mirrors the WorkOS provider's interface so the ~40 API routes are unaffected.
//
// Flow:
//   /auth/sign-in  → generate PKCE verifier + state (stored in short-lived
//                    httpOnly cookies), redirect to the issuer's authorize URL.
//   /auth/callback → exchange the code (verifying state + PKCE), fetch userinfo,
//                    map claims → CurrentUser, seal the iron-session, redirect.
//   /auth/sign-out → destroy the iron-session (+ optional RP-initiated logout).
//   middleware     → proactively refresh the access token via the refresh token.
import * as oidc from "openid-client";
import { redirect } from "next/navigation";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAppUrl } from "@/lib/url-config";
import {
  buildSessionFromTokens,
  getOidcConfig,
  getOidcRedirectUri,
  getOidcScopes,
  getPostLoginPath,
  mapOidcClaims,
  OIDC_PKCE_COOKIE,
  OIDC_STATE_COOKIE
} from "./oidc-config";
import { getOidcSession } from "./oidc-session";
import { UnauthorizedError, type AuthProvider, type CurrentUser } from "./types";

// Refresh when the access token is within this window of expiry.
const REFRESH_SKEW_MS = 60_000;
const TX_COOKIE_MAX_AGE = 600; // 10 min for the in-flight auth transaction.

async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const session = await getOidcSession();
    return session.user ?? null;
  } catch {
    return null;
  }
}

async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/auth/sign-in");
  }
  return user;
}

async function requireUserForApi(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthorizedError("Sign in is required.");
  }
  return user;
}

async function getSignInUrl(): Promise<string> {
  return "/auth/sign-in";
}

async function handleSignIn(): Promise<Response> {
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
  response.cookies.set(OIDC_PKCE_COOKIE, codeVerifier, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
    maxAge: TX_COOKIE_MAX_AGE
  });
  response.cookies.set(OIDC_STATE_COOKIE, state, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
    maxAge: TX_COOKIE_MAX_AGE
  });
  return response;
}

async function handleCallback(request: NextRequest): Promise<Response> {
  const config = await getOidcConfig();
  const codeVerifier = request.cookies.get(OIDC_PKCE_COOKIE)?.value;
  const expectedState = request.cookies.get(OIDC_STATE_COOKIE)?.value;

  if (!codeVerifier || !expectedState) {
    return new Response("OIDC authentication transaction expired or missing.", { status: 400 });
  }

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

  const response = NextResponse.redirect(new URL(getPostLoginPath(), getAppUrl()).href);
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
  let target = getAppUrl();
  try {
    const config = await getOidcConfig();
    const meta = config.serverMetadata();
    if (meta.end_session_endpoint) {
      const url = new URL(meta.end_session_endpoint);
      if (idToken) {
        url.searchParams.set("id_token_hint", idToken);
      }
      url.searchParams.set("post_logout_redirect_uri", getAppUrl());
      target = url.href;
    }
  } catch {
    // Discovery failure → fall back to local sign-out only.
  }

  return NextResponse.redirect(target);
}

async function runMiddleware(
  request: NextRequest,
  _event: NextFetchEvent
): Promise<Response | undefined> {
  // Only attempt silent refresh; never force cookie auth here (the page/API
  // gates own access decisions, and /api/forge/* must stay token-path only).
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
  requireUser,
  requireUserForApi,
  getSignInUrl,
  handleSignIn,
  handleCallback,
  handleSignOut,
  runMiddleware
};
