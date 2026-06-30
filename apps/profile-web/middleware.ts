import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAuthProvider } from "@/lib/auth-provider";

// Delegate the per-request session step to the active provider:
//   - workos (default): AuthKit middleware silent refresh — behaviorally
//     identical to the original direct `authkitMiddleware(...)` wiring.
//   - oidc (self-host): iron-session access-token silent refresh.
// Neither forces cookie auth; the page/API gates own access decisions.
export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  const provider = await getAuthProvider();
  return (await provider.runMiddleware(request, event)) ?? NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
