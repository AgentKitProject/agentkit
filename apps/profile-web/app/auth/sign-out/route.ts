import { getAuthProvider } from "@/lib/auth-provider";
import type { NextRequest } from "next/server";

// Force dynamic so Next.js never caches this route at build time.
// Without this, the handler may be skipped in production and cookies
// are never cleared, leaving the session active.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const provider = await getAuthProvider();
  return provider.handleSignOut(request);
}
