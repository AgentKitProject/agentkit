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

async function clearAuthKitCookies() {
  const cookieStore = await cookies();
  const sessionCookieName = process.env.WORKOS_COOKIE_NAME || DEFAULT_WORKOS_SESSION_COOKIE;

  for (const { name } of cookieStore.getAll()) {
    if (name === sessionCookieName || name === WORKOS_PKCE_COOKIE_PREFIX || name.startsWith(`${WORKOS_PKCE_COOKIE_PREFIX}-`)) {
      cookieStore.delete(name);
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
