import { getAuthProvider } from "@/lib/auth-provider";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  // Delegate the per-request session step to the active provider (WorkOS silent
  // refresh, or OIDC iron-session refresh). Both degrade gracefully when their
  // env is unconfigured. Neither forces cookie auth on /api/forge/* (device
  // bearer) or /api/forge/service/* (service key) — access decisions live in the
  // routes/pages themselves (CLAUDE.md hard rule #4).
  const provider = await getAuthProvider();
  return (await provider.runMiddleware(request, event)) ?? NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"]
};
