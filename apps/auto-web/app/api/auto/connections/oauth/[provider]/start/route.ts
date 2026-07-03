// GET /api/auto/connections/oauth/[provider]/start — begin the OAuth
// connection flow (BROWSER / cookie; provider gdrive|dropbox).
//
// Authed → generates a state nonce, stores it in a short-lived httpOnly cookie
// (10 min, mirroring the OIDC sign-in TX cookies), and 302s to the provider's
// consent screen (auto-core's buildOAuthAuthorizationUrl — least-privilege
// scopes: drive.file / files.content.*). Unconfigured provider app credentials
// (OAUTH_<PROVIDER>_CLIENT_ID/SECRET) → 501.
import { NextResponse } from "next/server";
import {
  buildOAuthAuthorizationUrl,
  isOAuthProvider,
  loadOAuthClientConfig,
} from "@agentkitforge/auto-core";
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  AUTO_OAUTH_STATE_COOKIE,
  AUTO_OAUTH_STATE_MAX_AGE,
  generateOAuthState,
  oauthRedirectUri,
} from "@/server/core/auto-oauth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    await requireUserForApi();
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
  const config = loadOAuthClientConfig(provider);
  if (!config) {
    return Response.json(
      { error: "not_implemented", message: `${provider} is not configured on this instance.` },
      { status: 501 },
    );
  }

  const state = generateOAuthState();
  const authorizeUrl = buildOAuthAuthorizationUrl({
    provider,
    clientId: config.clientId,
    redirectUri: oauthRedirectUri(provider),
    state,
  });

  const response = NextResponse.redirect(authorizeUrl, 302);
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(AUTO_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: AUTO_OAUTH_STATE_MAX_AGE,
  });
  return response;
}
