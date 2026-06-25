import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserRole } from "@/lib/auth/roles";
import { getProfileForUser } from "@/lib/profile/service";

// Force dynamic so this runs per-request and is never statically cached.
// Like the sign-out route, this must read live session cookies.
export const dynamic = "force-dynamic";

// Cross-origin credentialed fetch is used by the static marketing sites to
// render an ecosystem-wide login indicator. Credentials require an explicit
// origin (never "*"), so we reflect the request Origin only when allowlisted.
const ALLOWED_ORIGINS = new Set([
  "https://agentkitproject.com",
  "https://forge.agentkitproject.com",
  "https://docs.agentkitproject.com",
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export async function GET(request: Request) {
  const headers: Record<string, string> = {
    ...corsHeaders(request),
    "Cache-Control": "no-store",
  };

  const user = await getCurrentUser();

  if (!user || !user.id) {
    return NextResponse.json({ signedIn: false }, { headers });
  }

  // Best-effort enrichment: signedIn alone is the contract minimum, so any
  // profile-service failure degrades to the bare signed-in response.
  let displayName: string | undefined;
  let avatarInitials: string | undefined;

  try {
    const profile = await getProfileForUser(user, getUserRole(user));
    displayName = profile.displayName || undefined;
    avatarInitials = profile.avatarInitials || undefined;
  } catch (error) {
    console.warn("[me] profile enrichment failed", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }

  return NextResponse.json(
    {
      signedIn: true,
      ...(displayName ? { displayName } : {}),
      ...(avatarInitials ? { avatarInitials } : {}),
    },
    { headers },
  );
}
