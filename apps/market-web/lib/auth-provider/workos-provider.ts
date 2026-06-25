// WorkOS/AuthKit provider — the HOSTED SaaS path (AUTH_PROVIDER unset | "workos").
//
// This is the original direct-AuthKit wiring, relocated VERBATIM behind the
// AuthProvider interface so the hosted path stays 100% behaviorally identical:
//   - same `wos-session` cookie + AuthKit middleware silent refresh,
//   - same `withAuth()` / `getSignInUrl()` / `handleAuth()` / `saveSession()`,
//   - same redirect URIs, returnTo handling, and cookie-clearing on sign-out,
//   - same auth-debug logging and admin-by-email role mapping.
import {
  authkitMiddleware,
  getSignInUrl as workosGetSignInUrl,
  handleAuth,
  saveSession,
  withAuth,
  type UserInfo
} from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { logAuthDebug, logAuthError } from "@/lib/auth-debug";
import { getUserRole } from "@/lib/roles";
import {
  getAppUrl,
  getSignOutReturnUrl,
  getWorkOSRedirectUri,
  resolveAuthReturnTo,
  UrlConfigError
} from "@/lib/url-config";
import { isAdminEmail } from "@/lib/admin-emails";
import { UnauthorizedError, type AuthProvider, type CurrentUser } from "./types.ts";

const DEFAULT_WORKOS_SESSION_COOKIE = "wos-session";
const WORKOS_PKCE_COOKIE_PREFIX = "wos-auth-verifier";

function mapWorkOSUser(auth: UserInfo): CurrentUser {
  const email = auth.user.email ?? "";
  return {
    id: auth.user.id,
    email,
    firstName: auth.user.firstName,
    lastName: auth.user.lastName,
    role: getUserRole(email)
  };
}

async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const auth = await withAuth();

    if (!auth.user) {
      logAuthDebug("current-user-missing", { authenticated: false });
      return null;
    }

    const user = mapWorkOSUser(auth);
    logAuthDebug("current-user-success", {
      authenticated: true,
      email: user.email,
      role: user.role,
      isAdminEmail: isAdminEmail(user.email)
    });
    return user;
  } catch (error) {
    logAuthError("current-user-failure", error);
    return null;
  }
}

async function requireUser(): Promise<CurrentUser> {
  const auth = await withAuth({ ensureSignedIn: true });
  const user = mapWorkOSUser(auth);
  logAuthDebug("require-user-success", {
    authenticated: true,
    email: user.email,
    role: user.role
  });
  return user;
}

async function requireUserForApi(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthorizedError("Sign in is required.");
  }
  return user;
}

async function handleSignIn(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  let returnTo: string;

  try {
    const appUrl = getAppUrl();
    returnTo = resolveAuthReturnTo(url.searchParams.get("returnTo"), appUrl);
  } catch (error) {
    if (error instanceof UrlConfigError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }

  const signInUrl = await workosGetSignInUrl({
    returnTo,
    redirectUri: getWorkOSRedirectUri()
  });

  return NextResponse.redirect(signInUrl);
}

function buildAuthCallback() {
  return handleAuth({
    baseURL: getAppUrl(),
    returnPathname: "/",
    onSuccess: async ({ accessToken, refreshToken, user, impersonator, authenticationMethod }) => {
      await saveSession(
        { accessToken, refreshToken, user, impersonator, authenticationMethod },
        getWorkOSRedirectUri()
      );
      logAuthDebug("callback-session-created", {
        authenticated: true,
        email: user.email,
        userId: user.id,
        cookieUrl: getWorkOSRedirectUri()
      });
    },
    onError: ({ error, request }) => {
      logAuthError("callback-error", error, {
        callbackUrl: request.nextUrl.pathname,
        hasCode: request.nextUrl.searchParams.has("code"),
        hasState: request.nextUrl.searchParams.has("state")
      });
      return new Response("Authentication failed.", { status: 500 });
    }
  });
}

async function handleCallback(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  logAuthDebug("callback-hit", {
    callbackUrl: url.pathname,
    hasCode: url.searchParams.has("code"),
    hasState: url.searchParams.has("state")
  });
  return buildAuthCallback()(request);
}

function isPrefetchOrRscRequest(request: NextRequest): boolean {
  const headers = request.headers;
  return (
    headers.get("next-router-prefetch") === "1" ||
    headers.get("purpose") === "prefetch" ||
    headers.get("sec-purpose") === "prefetch" ||
    headers.has("rsc")
  );
}

function deleteAuthKitCookie(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  name: string
) {
  // AuthKit writes the session (and PKCE) cookies with `Domain=$WORKOS_COOKIE_DOMAIN`
  // when that env var is set (e.g. a shared ".agentkitproject.com" cookie). Per the
  // cookie spec, a Set-Cookie deletion is only honored when its Domain attribute
  // matches the one used to set it — a host-only `delete(name)` cannot clear a
  // domain-scoped cookie, so the session would survive sign-out. Delete with the
  // configured domain first, then host-only as a fallback for cookies written
  // before the domain was configured (and for environments that only accept a
  // string name).
  const domain = process.env.WORKOS_COOKIE_DOMAIN;
  if (domain) {
    try {
      cookieStore.delete({ name, domain, path: "/" });
    } catch {
      // Some runtimes only accept a string cookie name; fall through to host-only.
    }
  }
  cookieStore.delete(name);
}

async function clearAuthKitCookies() {
  const cookieStore = await cookies();
  const sessionCookieName = process.env.WORKOS_COOKIE_NAME || DEFAULT_WORKOS_SESSION_COOKIE;
  for (const { name } of cookieStore.getAll()) {
    if (
      name === sessionCookieName ||
      name === WORKOS_PKCE_COOKIE_PREFIX ||
      name.startsWith(`${WORKOS_PKCE_COOKIE_PREFIX}-`)
    ) {
      deleteAuthKitCookie(cookieStore, name);
    }
  }
}

async function handleSignOut(request: NextRequest): Promise<Response> {
  if (isPrefetchOrRscRequest(request)) {
    return new NextResponse(null, { status: 204 });
  }

  let returnTo: string;
  try {
    returnTo = getSignOutReturnUrl();
  } catch (error) {
    if (error instanceof UrlConfigError) {
      logAuthError("sign-out-config-error", error);
      return new Response(error.message, { status: 500 });
    }
    throw error;
  }

  logAuthDebug("sign-out-route-hit", {
    returnToOrigin: new URL(returnTo).origin
  });

  await clearAuthKitCookies();
  return NextResponse.redirect(returnTo);
}

function hasWorkOSEnv() {
  return Boolean(
    process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID && process.env.WORKOS_COOKIE_PASSWORD
  );
}

let authkit: ReturnType<typeof authkitMiddleware> | null = null;
function getAuthkit() {
  if (!authkit) {
    authkit = authkitMiddleware({
      debug: process.env.AGENTKITMARKET_AUTH_DEBUG === "true",
      redirectUri: getWorkOSRedirectUri()
    });
  }
  return authkit;
}

async function runMiddleware(
  request: NextRequest,
  event: NextFetchEvent
): Promise<Response | undefined> {
  if (!hasWorkOSEnv()) {
    logAuthDebug("middleware-workos-env-missing", {
      path: request.nextUrl.pathname,
      hasWorkOSApiKey: Boolean(process.env.WORKOS_API_KEY),
      hasWorkOSClientId: Boolean(process.env.WORKOS_CLIENT_ID),
      hasCookiePassword: Boolean(process.env.WORKOS_COOKIE_PASSWORD)
    });
    return undefined;
  }

  const response = (await getAuthkit()(request, event)) ?? NextResponse.next();
  const setCookie = response.headers.get("set-cookie");

  if (setCookie?.includes("Max-Age=0") || setCookie?.includes("Expires=Thu, 01 Jan 1970")) {
    logAuthDebug("middleware-session-cookie-delete", {
      path: request.nextUrl.pathname
    });
  }

  return response;
}

export const workosProvider: AuthProvider = {
  id: "workos",
  getCurrentUser,
  requireUser,
  requireUserForApi,
  handleSignIn,
  handleCallback,
  handleSignOut,
  runMiddleware
};
