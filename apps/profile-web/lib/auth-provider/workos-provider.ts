// WorkOS/AuthKit provider — the HOSTED SaaS path (AUTH_PROVIDER unset | "workos").
//
// This is the original direct-AuthKit wiring, relocated VERBATIM behind the
// AuthProvider interface so the hosted path stays 100% behaviorally identical:
//   - same `wos-session` cookie + AuthKit middleware silent refresh,
//   - same `withAuth()` / `getSignInUrl()` / `getSignUpUrl()` / `handleAuth()`,
//   - same redirect URIs, returnTo handling, sign-up mode, and cookie-clearing
//     on sign-out (incl. domain-scoped deletion).
import {
  authkitMiddleware,
  getSignInUrl as workosGetSignInUrl,
  getSignUpUrl as workosGetSignUpUrl,
  handleAuth,
  withAuth
} from "@workos-inc/authkit-nextjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAppHomeUrl, getAppUrl, getWorkOSRedirectUri, safeReturnTo } from "@/lib/auth/urls";
import { type AgentKitUser, type AuthProvider } from "./types.ts";

const DEFAULT_WORKOS_SESSION_COOKIE = "wos-session";
const WORKOS_PKCE_COOKIE_PREFIX = "wos-auth-verifier";

type WorkOSUser = NonNullable<Awaited<ReturnType<typeof withAuth>>["user"]>;

function mapWorkOSUser(user: WorkOSUser): AgentKitUser {
  return {
    id: user.id,
    email: user.email ?? null,
    firstName: user.firstName,
    lastName: user.lastName
  };
}

async function getCurrentUser(): Promise<AgentKitUser | null> {
  const { user } = await withAuth();
  return user ? mapWorkOSUser(user) : null;
}

// The sealed WorkOS session cookie shape (a subset of authkit's `Session`).
type SealedWorkOSSession = { user?: WorkOSUser | null };

/**
 * Middleware-safe: unseal the `wos-session` cookie straight from
 * `request.cookies` with `WORKOS_COOKIE_PASSWORD` — reachable from the edge
 * runtime without `next/headers`. We deliberately do NOT re-verify the JWT
 * signature here: the cookie is sealed with the server-only secret (it cannot be
 * forged), and this only decides a require-login gate. Never throws — null when
 * absent/unsealable.
 */
async function getMiddlewareUser(request: NextRequest): Promise<AgentKitUser | null> {
  const password = process.env.WORKOS_COOKIE_PASSWORD;
  if (!password || password.length < 32) {
    return null;
  }
  const cookieName = process.env.WORKOS_COOKIE_NAME || DEFAULT_WORKOS_SESSION_COOKIE;
  const sealed = request.cookies.get(cookieName)?.value;
  if (!sealed) {
    return null;
  }
  try {
    const { unsealData } = await import("iron-session");
    const session = await unsealData<SealedWorkOSSession>(sealed, { password });
    return session?.user ? mapWorkOSUser(session.user) : null;
  } catch {
    return null;
  }
}

async function requireUser(returnTo?: string): Promise<AgentKitUser> {
  const { user } = await withAuth();

  if (!user) {
    const returnPath = safeReturnTo(returnTo ?? (await getCurrentRequestPath()));

    console.info("[auth] protected route auth missing", {
      returnTo: returnPath
    });

    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(returnPath)}`);
  }

  return mapWorkOSUser(user);
}

async function getCurrentRequestPath() {
  const headersList = await headers();
  const requestUrl = headersList.get("x-url");

  if (!requestUrl) {
    return "/account";
  }

  try {
    const parsed = new URL(requestUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/account";
  }
}

async function handleSignIn(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const returnTo = safeReturnTo(searchParams.get("returnTo"));

  console.info("[auth] sign-in route hit", {
    returnTo
  });

  const signInUrl =
    searchParams.get("mode") === "sign-up"
      ? await workosGetSignUpUrl({ redirectUri: getWorkOSRedirectUri(), returnTo })
      : await workosGetSignInUrl({ redirectUri: getWorkOSRedirectUri(), returnTo });

  return NextResponse.redirect(signInUrl);
}

async function handleCallback(request: NextRequest): Promise<Response> {
  return handleAuth({
    baseURL: getAppUrl(),
    returnPathname: "/account"
  })(request);
}

function isPrefetchOrRscRequest(request: NextRequest): boolean {
  const requestHeaders = request.headers;
  return (
    requestHeaders.get("next-router-prefetch") === "1" ||
    requestHeaders.get("purpose") === "prefetch" ||
    requestHeaders.get("sec-purpose") === "prefetch" ||
    requestHeaders.has("rsc")
  );
}

function deleteAuthKitCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, name: string) {
  // AuthKit writes the session (and PKCE) cookies with `Domain=$WORKOS_COOKIE_DOMAIN`
  // when that env var is set (e.g. a shared ".agentkitproject.com" cookie). Per the
  // cookie spec, a Set-Cookie deletion is only honored when its Domain attribute
  // matches the one used to set it — a host-only `delete(name)` cannot clear a
  // domain-scoped cookie, so the session would survive sign-out. Delete with the
  // configured domain first, then host-only as a fallback.
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

  const returnTo = getAppHomeUrl();
  const returnToUrl = new URL(returnTo);

  console.info("[auth] sign-out route hit", {
    returnToOrigin: returnToUrl.origin
  });

  await clearAuthKitCookies();

  return NextResponse.redirect(returnToUrl);
}

let authkit: ReturnType<typeof authkitMiddleware> | null = null;
function getAuthkit() {
  if (!authkit) {
    authkit = authkitMiddleware({
      redirectUri: getWorkOSRedirectUri(),
      middlewareAuth: {
        enabled: false,
        unauthenticatedPaths: []
      }
    });
  }
  return authkit;
}

async function runMiddleware(
  request: NextRequest,
  event: NextFetchEvent
): Promise<Response | undefined> {
  return (await getAuthkit()(request, event)) ?? NextResponse.next();
}

export const workosProvider: AuthProvider = {
  id: "workos",
  getCurrentUser,
  getMiddlewareUser,
  requireUser,
  handleSignIn,
  handleCallback,
  handleSignOut,
  runMiddleware
};
