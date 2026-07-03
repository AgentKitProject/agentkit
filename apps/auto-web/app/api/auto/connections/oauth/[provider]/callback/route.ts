// GET /api/auto/connections/oauth/[provider]/callback — finish the OAuth
// connection flow (BROWSER / cookie; provider gdrive|dropbox).
//
// State cookie must match the returned `state` (mismatch/missing → 400); the
// authorization code is exchanged SERVER-SIDE (auto-core exchangeOAuthCode);
// the token set goes straight into the SecretStore (S2 — tokens never appear
// in any response) and the connection is created (ownerType user, status ok).
// Success → 302 back to the app root with ?connection=created.
import { NextResponse } from "next/server";
import { isOAuthProvider, loadOAuthClientConfig, OAuthExchangeError } from "@agentkitforge/auto-core";
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { getAppUrl } from "@/lib/url-config";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { autoEventErrorResponse } from "@/server/core/auto-events";
import { AUTO_OAUTH_STATE_COOKIE, completeOAuthConnection } from "@/server/core/auto-oauth";

export const dynamic = "force-dynamic";

/** Minimal cookie-header parse (framework-agnostic; the route only needs one
 *  cookie and plain Request keeps the handler trivially testable). */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { provider } = await params;
  if (!isOAuthProvider(provider)) {
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: `Unknown OAuth provider "${provider}".` },
      { status: 400 },
    );
  }
  if (!loadOAuthClientConfig(provider)) {
    return Response.json(
      { error: "not_implemented", message: `${provider} is not configured on this instance.` },
      { status: 501 },
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, AUTO_OAUTH_STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    return Response.json(
      {
        error: autoErrorCodeSchema.enum.invalid_request,
        message: "OAuth state mismatch or expired transaction — restart the connection flow.",
      },
      { status: 400 },
    );
  }

  try {
    await completeOAuthConnection({ userId, provider, code });
  } catch (error) {
    if (error instanceof OAuthExchangeError) {
      return Response.json(
        { error: autoErrorCodeSchema.enum.invalid_request, message: error.message },
        { status: 400 },
      );
    }
    const mapped = autoEventErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  }

  const base = getAppUrl().replace(/\/$/, "");
  const response = NextResponse.redirect(`${base}/?connection=created`, 302);
  response.cookies.delete(AUTO_OAUTH_STATE_COOKIE);
  return response;
}
