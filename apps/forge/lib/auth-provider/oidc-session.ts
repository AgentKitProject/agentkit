// iron-session sealed cookie for the generic OIDC provider (self-hosted).
//
// The session holds the mapped CurrentUser plus the OIDC tokens needed for
// silent refresh and (optional) RP-initiated logout. The cookie is AEAD-sealed
// by iron-session using a 32+ char secret (SESSION_SECRET, falling back to the
// existing WORKOS_COOKIE_PASSWORD so a single secret can serve both providers).
import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import type { CurrentUser } from "./types";

export const OIDC_SESSION_COOKIE = "akf-oidc-session";

export type OidcSessionData = {
  user?: CurrentUser;
  // NOTE: the access token is intentionally NOT stored. This sealed cookie
  // already holds user + refreshToken + idToken; adding the (~1.5KB) Keycloak
  // access token pushed the sealed cookie past the ~4KB browser limit and broke
  // login. The hosted-Market bearer is sourced from `idToken` instead (see
  // server/core/market-auth.ts). Do not re-add an `accessToken` field here.
  refreshToken?: string;
  idToken?: string;
  // Absolute expiry (epoch ms) of the access token, for proactive refresh.
  expiresAt?: number;
};

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

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
