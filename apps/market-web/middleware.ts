import { getAuthProvider } from "@/lib/auth-provider";
import {
  requireLoginEnabled,
  isRequireLoginExemptPath,
  requireLoginGateDecision
} from "@/lib/require-login";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  // Delegate the per-request session step to the active provider (WorkOS silent
  // refresh, or OIDC iron-session refresh). Both degrade gracefully when their
  // env is unconfigured. Neither forces cookie auth on /api/forge/* (device
  // bearer) or /api/forge/service/* (service key) — access decisions live in the
  // routes/pages themselves (CLAUDE.md hard rule #4).
  const provider = await getAuthProvider();
  const providerResponse = (await provider.runMiddleware(request, event)) ?? NextResponse.next();

  // Instance-level require-login gate (self-host). DEFAULT OFF → public catalog
  // (hosted marketplace unaffected). When REQUIRE_LOGIN=true, a request to a
  // non-exempt path with no cookie session is redirected to sign-in (pages) or
  // 401'd (API). Exempt: /auth/*, /api/forge/* (+ /api/forge/service/*), /healthz.
  if (requireLoginEnabled()) {
    const pathname = request.nextUrl.pathname;
    // Only resolve the session for paths that are actually gateable (non-exempt),
    // so exempt paths skip the (potentially costly) cookie unseal.
    if (!isRequireLoginExemptPath(pathname)) {
      // Fail CLOSED: any error resolving the session → treated as unauthenticated.
      const user = await provider.getMiddlewareUser(request).catch(() => null);
      const decision = requireLoginGateDecision({
        enabled: true,
        pathname,
        authenticated: Boolean(user)
      });
      if (decision === "unauthorized") {
        return NextResponse.json(
          { error: "Sign in is required for this instance." },
          { status: 401 }
        );
      }
      if (decision === "redirect") {
        const signInUrl = new URL("/auth/sign-in", request.nextUrl.origin);
        // Send the user back to where they were after login.
        signInUrl.searchParams.set(
          "returnTo",
          request.nextUrl.pathname + request.nextUrl.search
        );
        return NextResponse.redirect(signInUrl);
      }
    }
  }

  return providerResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"]
};
