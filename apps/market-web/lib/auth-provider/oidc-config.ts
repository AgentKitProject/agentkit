// OIDC discovery + claim mapping for the generic self-hosted provider.
import * as oidc from "openid-client";
import { getAppUrl } from "../url-config.ts";
import type { AgentKitMarketRole } from "@/lib/permissions";
import type { OidcSessionData } from "./oidc-session.ts";
import type { CurrentUser } from "./types.ts";

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcConfigError";
  }
}

export const DEFAULT_OIDC_SCOPES = "openid profile email";
export const OIDC_STATE_COOKIE = "akm-oidc-state";
export const OIDC_PKCE_COOKIE = "akm-oidc-verifier";

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

function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Admin allowlist for the OIDC (self-hosted) path. Falls back to
 * AGENTKITMARKET_ADMIN_EMAILS so a self-host can reuse the hosted var if it
 * prefers; ADMIN_EMAILS takes precedence when set.
 */
function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? process.env.AGENTKITMARKET_ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map(normalizeEmail)
    .filter((email): email is string => Boolean(email));
}

/** Extract group/role membership from common OIDC claim shapes. */
function claimGroups(claims: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["groups", "roles"]) {
    const value = claims[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) {
          out.push(entry.trim());
        }
      }
    } else if (typeof value === "string" && value.trim()) {
      out.push(value.trim());
    }
  }
  return out;
}

/**
 * Determine the Market role from OIDC claims for the self-hosted path. Admin is
 * granted when EITHER the configured ADMIN_OIDC_GROUP appears in the token's
 * group/role claims, OR the email is in the ADMIN_EMAILS allowlist. A self-host
 * operator can pick whichever fits their IdP; if neither is configured, no user
 * is an admin (they can still browse/submit as a regular user).
 */
export function resolveOidcRole(claims: Record<string, unknown>, email: string): AgentKitMarketRole {
  const adminGroup = process.env.ADMIN_OIDC_GROUP?.trim();
  if (adminGroup && claimGroups(claims).includes(adminGroup)) {
    return "admin";
  }

  const normalized = normalizeEmail(email);
  if (normalized && adminEmails().includes(normalized)) {
    return "admin";
  }

  return email ? "user" : "anonymous";
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
  return { id: sub, email, firstName, lastName, role: resolveOidcRole(claims, email) };
}

/** Build the OidcSessionData from a token-endpoint response + claims. */
export function buildSessionFromTokens(
  user: CurrentUser,
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
