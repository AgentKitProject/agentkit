// WorkOS/AuthKit provider — the HOSTED SaaS path (AUTH_PROVIDER unset | "workos").
//
// This is the original direct-AuthKit wiring, relocated VERBATIM behind the
// AuthProvider interface so the hosted path stays 100% behaviorally identical:
//   - same `wos-session` cookie + AuthKit middleware silent refresh,
//   - same `withAuth()` / `getSignInUrl()` / `handleAuth()` / `saveSession()`,
//   - same redirect URIs and cookie-clearing on sign-out.
import {
  authkitMiddleware,
  getSignInUrl as workosGetSignInUrl,
  handleAuth,
  saveSession,
  withAuth,
  type UserInfo
} from "@workos-inc/authkit-nextjs";
import type { User } from "@workos-inc/node";
import { cookies } from "next/headers";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAppUrl, getWorkOSRedirectUri } from "@/lib/url-config";
import { UnauthorizedError, type AuthProvider, type CurrentUser } from "./types";

const DEFAULT_WORKOS_SESSION_COOKIE = "wos-session";
const WORKOS_PKCE_COOKIE_PREFIX = "wos-auth-verifier";

function mapWorkOSUser(auth: UserInfo): CurrentUser {
  return {
    id: auth.user.id,
    email: getUserEmail(auth.user) ?? "",
    firstName: auth.user.firstName,
    lastName: auth.user.lastName
  };
}

export function getUserEmail(user?: Pick<User, "email"> | CurrentUser | null) {
  return user?.email ?? null;
}

async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const auth = await withAuth();
    if (!auth.user) {
      return null;
    }
    return mapWorkOSUser(auth);
  } catch {
    return null;
  }
}

async function requireUser(): Promise<CurrentUser> {
  const auth = await withAuth({ ensureSignedIn: true });
  return mapWorkOSUser(auth);
}

async function requireUserForApi(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthorizedError("Sign in is required.");
  }
  return user;
}

async function getSignInUrl(): Promise<string> {
  return workosGetSignInUrl({ redirectUri: getWorkOSRedirectUri() });
}

async function handleSignIn(): Promise<Response> {
  const signInUrl = await workosGetSignInUrl({ redirectUri: getWorkOSRedirectUri() });
  return NextResponse.redirect(signInUrl);
}

function buildAuthCallback() {
  return handleAuth({
    baseURL: getAppUrl(),
    returnPathname: "/forge",
    onSuccess: async ({ accessToken, refreshToken, user, impersonator, authenticationMethod }) => {
      await saveSession(
        { accessToken, refreshToken, user, impersonator, authenticationMethod },
        getWorkOSRedirectUri()
      );
    },
    onError: () => new Response("Authentication failed.", { status: 500 })
  });
}

async function handleCallback(request: NextRequest): Promise<Response> {
  return buildAuthCallback()(request);
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
      cookieStore.delete(name);
    }
  }
}

async function handleSignOut(): Promise<Response> {
  await clearAuthKitCookies();
  return NextResponse.redirect(getAppUrl());
}

function hasWorkOSEnv() {
  return Boolean(
    process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID && process.env.WORKOS_COOKIE_PASSWORD
  );
}

let authkit: ReturnType<typeof authkitMiddleware> | null = null;
function getAuthkit() {
  if (!authkit) {
    authkit = authkitMiddleware({ redirectUri: getWorkOSRedirectUri() });
  }
  return authkit;
}

async function runMiddleware(
  request: NextRequest,
  event: NextFetchEvent
): Promise<Response | undefined> {
  // Degrade gracefully when WorkOS env is not configured (e.g. local dev,
  // `next build` data collection) so the app/build does not hard-crash.
  if (!hasWorkOSEnv()) {
    return undefined;
  }
  return (await getAuthkit()(request, event)) ?? undefined;
}

export const workosProvider: AuthProvider = {
  id: "workos",
  getCurrentUser,
  requireUser,
  requireUserForApi,
  getSignInUrl,
  handleSignIn,
  handleCallback,
  handleSignOut,
  runMiddleware
};
