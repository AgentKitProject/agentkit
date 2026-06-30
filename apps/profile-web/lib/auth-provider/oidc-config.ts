// OIDC discovery + claim mapping for the generic self-hosted provider.
import * as oidc from "openid-client";
import { getAppUrl } from "../auth/urls.ts";
import type { OidcSessionData } from "./oidc-session.ts";
import type { AgentKitUser } from "./types.ts";

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

export const DEFAULT_OIDC_SCOPES = "openid profile email";
export const OIDC_STATE_COOKIE = "akp-oidc-state";
export const OIDC_PKCE_COOKIE = "akp-oidc-verifier";

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
      return oidc.discovery(
        new URL(issuer),
        clientId,
        clientSecret,
        undefined,
        execute ? { execute } : undefined
      );
    })();
  }
  return configPromise;
}

/** Map OIDC ID-token / userinfo claims onto the abstract AgentKitUser shape. */
export function mapOidcClaims(claims: Record<string, unknown>): AgentKitUser {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    null;
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
  user: AgentKitUser,
  tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers
): OidcSessionData {
  const expiresIn = tokens.expiresIn();
  return {
    user,
    accessToken: tokens.access_token,
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
