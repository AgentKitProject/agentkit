import { getAuthProvider } from "@/lib/auth-provider";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// Routes that authenticate WITHOUT the cookie session and must never have cookie
// auth / session-refresh run on them (CLAUDE.md HARD RULE #4 — device-bearer and
// cookie sessions are separate auth paths):
//   /api/forge/*    — Forge device-auth bearer JWT (requireForgeUser)
//   /api/hooks/*    — public inbound webhooks (per-webhook secret)
//   /api/internal/* — service-key trusted internal calls
const NON_COOKIE_AUTH_PREFIXES = ["/api/forge/", "/api/hooks/", "/api/internal/"];

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  // Never let the cookie middleware touch the bearer/webhook/service routes —
  // they own their own auth and must not get a session-cookie refresh. This
  // skip-list is provider-agnostic (applies under both WorkOS and OIDC).
  if (NON_COOKIE_AUTH_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  // Delegate the per-request session step to the active provider (WorkOS silent
  // refresh, or OIDC iron-session refresh). Both degrade gracefully when their
  // env is unconfigured. Neither forces cookie auth — access decisions live in
  // the routes/pages themselves.
  return (await getAuthProvider().runMiddleware(request, event)) ?? NextResponse.next();
}

export const config = {
  // Health check + Next internals stay public.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|health).*)"]
};
