// iron-session sealed cookie for the generic OIDC provider (self-hosted).
//
// The session holds the mapped AgentKitUser plus the OIDC tokens needed for
// silent refresh and (optional) RP-initiated logout. The cookie is AEAD-sealed
// by iron-session using a 32+ char secret (SESSION_SECRET, falling back to the
// existing WORKOS_COOKIE_PASSWORD so a single secret can serve both providers).
import { getIronSession, unsealData, type IronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { OidcConfigError } from "./oidc-config.ts";
import type { AgentKitUser } from "./types.ts";

export const OIDC_SESSION_COOKIE = "akp-oidc-session";

export type OidcSessionData = {
  user?: AgentKitUser;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  // Absolute expiry (epoch ms) of the access token, for proactive refresh.
  expiresAt?: number;
};

export { OidcConfigError };

export function getSessionSecret(): string {
  const secret = (process.env.SESSION_SECRET || process.env.WORKOS_COOKIE_PASSWORD || "").trim();
  if (secret.length < 32) {
    throw new OidcConfigError(
      "SESSION_SECRET (or WORKOS_COOKIE_PASSWORD) must be set and at least 32 characters for OIDC sessions."
    );
  }
  return secret;
}

export function sessionOptions(): SessionOptions {
  return {
    cookieName: process.env.OIDC_SESSION_COOKIE || OIDC_SESSION_COOKIE,
    password: getSessionSecret(),
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/"
    }
  };
}

/** Read/write the sealed session bound to the request's cookie jar. */
export async function getOidcSession(): Promise<IronSession<OidcSessionData>> {
  const cookieStore = await cookies();
  return getIronSession<OidcSessionData>(cookieStore, sessionOptions());
}

/**
 * Middleware-safe read: unseal the OIDC session straight from `request.cookies`
 * (the edge runtime has no `next/headers` cookie store). Returns the decoded
 * session data, or null when the cookie is absent / cannot be unsealed (tampered,
 * expired seal, or a missing/short secret). Never throws.
 */
export async function unsealOidcSessionCookie(
  request: NextRequest
): Promise<OidcSessionData | null> {
  const cookieName = process.env.OIDC_SESSION_COOKIE || OIDC_SESSION_COOKIE;
  const sealed = request.cookies.get(cookieName)?.value;
  if (!sealed) {
    return null;
  }
  try {
    const data = await unsealData<OidcSessionData>(sealed, { password: getSessionSecret() });
    return data && typeof data === "object" && Object.keys(data).length > 0 ? data : null;
  } catch {
    return null;
  }
}
