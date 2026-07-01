// OIDC discovery + claim mapping for the generic self-hosted provider.
import * as oidc from "openid-client";
import { getAppUrl } from "@/lib/url-config";
import { OidcConfigError, type OidcSessionData } from "./oidc-session";
import type { CurrentUser } from "./types";

export const DEFAULT_OIDC_SCOPES = "openid profile email";
export const OIDC_STATE_COOKIE = "akf-oidc-state";
export const OIDC_PKCE_COOKIE = "akf-oidc-verifier";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new OidcConfigError(`${name} is required when AUTH_PROVIDER=oidc.`);
  }
  return value;
}

export function getOidcScopes(): string {
  return process.env.OIDC_SCOPES?.trim() || DEFAULT_OIDC_SCOPES;
}

export function getOidcRedirectUri(): string {
  const explicit = process.env.OIDC_REDIRECT_URI?.trim();
  if (explicit) {
    return explicit;
  }
  return new URL("/auth/callback", getAppUrl()).toString();
}

/**
 * The in-app path to land on after a successful sign-in. AgentKitAuto is a
 * single-surface app whose dashboard lives at `/` (unlike Web Forge's `/forge`),
 * so the callback returns here. Overridable via env for parity with the WorkOS
 * callback's `returnPathname`.
 */
export function getPostLoginPath(): string {
  return process.env.AUTH_POST_LOGIN_PATH?.trim() || "/";
}

let configPromise: Promise<oidc.Configuration> | null = null;
let configKey: string | null = null;

/** Discover the OIDC issuer's metadata and cache the Configuration. */
export async function getOidcConfig(): Promise<oidc.Configuration> {
  const issuer = requiredEnv("OIDC_ISSUER");
  const clientId = requiredEnv("OIDC_CLIENT_ID");
  const clientSecret = requiredEnv("OIDC_CLIENT_SECRET");
  const key = `${issuer}|${clientId}`;

  if (!configPromise || configKey !== key) {
    configKey = key;
    configPromise = (async () => {
      const execute =
        process.env.OIDC_ALLOW_INSECURE === "true" ? [oidc.allowInsecureRequests] : undefined;
      return oidc.discovery(new URL(issuer), clientId, clientSecret, undefined, execute ? { execute } : undefined);
    })();
  }
  return configPromise;
}

/** Map OIDC ID-token / userinfo claims onto the abstract CurrentUser shape. */
export function mapOidcClaims(claims: Record<string, unknown>): CurrentUser {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    "";
  const given = typeof claims.given_name === "string" ? claims.given_name : null;
  const family = typeof claims.family_name === "string" ? claims.family_name : null;
  // Fall back to splitting `name` when given/family aren't provided.
  let firstName = given;
  let lastName = family;
  if (!firstName && typeof claims.name === "string" && claims.name.trim()) {
    const parts = claims.name.trim().split(/\s+/);
    firstName = parts[0] ?? null;
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : lastName;
  }
  return { id: sub, email, firstName, lastName };
}

/** Build the OidcSessionData from a token-endpoint response + claims. */
export function buildSessionFromTokens(
  user: CurrentUser,
  tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers
): OidcSessionData {
  const expiresIn = tokens.expiresIn();
  return {
    user,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined
  };
}

/** Test-only: reset the cached discovery config. */
export function __resetOidcConfigForTest(): void {
  configPromise = null;
  configKey = null;
}
