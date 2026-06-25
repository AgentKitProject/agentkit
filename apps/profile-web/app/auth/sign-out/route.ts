import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAppHomeUrl } from "@/lib/auth/urls";

// Force dynamic so Next.js never caches this route at build time.
// Without this, the handler may be skipped in production and cookies
// are never cleared, leaving the session active.
export const dynamic = "force-dynamic";

const DEFAULT_WORKOS_SESSION_COOKIE = "wos-session";
const WORKOS_PKCE_COOKIE_PREFIX = "wos-auth-verifier";

export async function GET(request: Request) {
  if (isPrefetchOrRscRequest(request)) {
    return new NextResponse(null, { status: 204 });
  }

  const returnTo = getAppHomeUrl();
  const returnToUrl = new URL(returnTo);

  console.info("[auth] sign-out route hit", {
    returnToOrigin: returnToUrl.origin,
  });

  await clearAuthKitCookies();

  return NextResponse.redirect(returnToUrl);
}

function deleteAuthKitCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, name: string) {
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
    if (name === sessionCookieName || name === WORKOS_PKCE_COOKIE_PREFIX || name.startsWith(`${WORKOS_PKCE_COOKIE_PREFIX}-`)) {
      deleteAuthKitCookie(cookieStore, name);
    }
  }
}

function isPrefetchOrRscRequest(request: Request) {
  const headers = request.headers;

  return (
    headers.get("next-router-prefetch") === "1" ||
    headers.get("purpose") === "prefetch" ||
    headers.get("sec-purpose") === "prefetch" ||
    headers.has("rsc")
  );
}
