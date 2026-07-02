// Forge device-auth (bearer) authentication for Web Forge's /api/forge/* routes.
//
// Mirrors agentkitmarket-app/lib/forge-auth.ts: NON-browser clients
// (desktop / CLI / Auto) authenticate with a WorkOS device-auth ACCESS TOKEN
// sent as `Authorization: Bearer <token>`, NOT the AuthKit cookie session.
//
// CLAUDE.md HARD RULE #4: Forge device-auth (bearer JWT) and WorkOS/AuthKit
// cookie sessions are SEPARATE auth paths and must never be conflated. The
// /api/forge/gateway/* routes use requireForgeUser() (this module); the
// /api/gateway/* (browser) routes use requireUserForApi() (lib/auth.ts). A
// route must use exactly one.
//
// The token is verified against WorkOS's remote JWKS for the device-flow
// client id (AGENTKITPROJECT_WORKOS_CLIENT_ID — the same client the desktop
// device flow authenticates against, per CLAUDE.md #2; falls back to
// WORKOS_CLIENT_ID so a single-client deployment still works). We require a
// `sub` claim and return { id, email?, sessionId? }.
import { createRemoteJWKSet, jwtVerify } from "jose";

export type ForgeAuthenticatedUser = {
  id: string;
  email?: string;
  sessionId?: string;
};

export type ForgeAuthFailureStage =
  | "missing_header"
  | "malformed_header"
  | "server_config"
  | "token_verification_failed"
  | "missing_user_identity";

export class ForgeAuthError extends Error {
  readonly code: "NOT_SIGNED_IN" | "INVALID_TOKEN" | "SERVER_CONFIG_ERROR" | "NOT_SUPPORTED";
  readonly status: number;
  readonly failureStage: ForgeAuthFailureStage;
  readonly authorizationHeaderPresent: boolean;
  readonly tokenLength: number;

  constructor(
    code: "NOT_SIGNED_IN" | "INVALID_TOKEN" | "SERVER_CONFIG_ERROR" | "NOT_SUPPORTED",
    message: string,
    status: number,
    diagnostics: {
      failureStage: ForgeAuthFailureStage;
      authorizationHeaderPresent?: boolean;
      tokenLength?: number;
    }
  ) {
    super(message);
    this.name = "ForgeAuthError";
    this.code = code;
    this.status = status;
    this.failureStage = diagnostics.failureStage;
    this.authorizationHeaderPresent = diagnostics.authorizationHeaderPresent ?? false;
    this.tokenLength = diagnostics.tokenLength ?? 0;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrl: string | null = null;

/**
 * Verifies the request's `Authorization: Bearer <WorkOS access token>` against
 * WorkOS's remote JWKS and returns the authenticated forge user. Throws
 * ForgeAuthError (with an HTTP status) on any failure.
 */
export async function requireForgeUser(request: Request): Promise<ForgeAuthenticatedUser> {
  // Under AUTH_PROVIDER=oidc (self-hosted) the device-bearer token is issued by
  // the configured OIDC IdP, not WorkOS. Verify it against the issuer's JWKS
  // (discovered IdP-agnostically) rather than the WorkOS JWKS. The WorkOS path
  // below is unchanged for the hosted deployment.
  if (isForgeOidcProvider()) {
    return requireForgeOidcUser(request);
  }

  const authorizationHeader = request.headers.get("authorization");
  const diagnostics = getForgeAuthorizationDiagnostics(authorizationHeader);
  const token = parseBearerToken(authorizationHeader);

  if (!token) {
    throw new ForgeAuthError("NOT_SIGNED_IN", "AgentKitProject sign-in is required.", 401, diagnostics);
  }

  try {
    const { payload } = await jwtVerify(token, getJwks());

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new ForgeAuthError("INVALID_TOKEN", "The Forge authentication token is missing user identity.", 401, {
        ...diagnostics,
        failureStage: "missing_user_identity"
      });
    }

    return {
      id: payload.sub,
      email: stringClaim(payload.email),
      sessionId: stringClaim(payload.sid)
    };
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      throw error;
    }

    throw new ForgeAuthError("INVALID_TOKEN", "The Forge authentication token is invalid or expired.", 401, {
      ...diagnostics,
      failureStage: "token_verification_failed"
    });
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseBearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export function getForgeAuthorizationDiagnostics(value: string | null): {
  authorizationHeaderPresent: boolean;
  tokenLength: number;
  failureStage: ForgeAuthFailureStage;
} {
  const token = parseBearerToken(value);

  return {
    authorizationHeaderPresent: Boolean(value),
    tokenLength: token?.length ?? 0,
    failureStage: !value ? "missing_header" : token ? "token_verification_failed" : "malformed_header"
  };
}

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  const url = getWorkOsJwksUrl();

  if (!jwks || jwksUrl !== url.href) {
    jwksUrl = url.href;
    jwks = createRemoteJWKSet(url);
  }

  return jwks;
}

function getWorkOsJwksUrl(): URL {
  // Device-auth tokens are issued against the AgentKitProject device-flow
  // client (CLAUDE.md #2); verify against THAT client's JWKS. Fall back to the
  // AuthKit client id when a deployment uses a single WorkOS client.
  const clientId =
    process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID || process.env.WORKOS_CLIENT_ID;

  if (!clientId) {
    throw new ForgeAuthError("SERVER_CONFIG_ERROR", "Forge authentication is not configured.", 500, {
      failureStage: "server_config"
    });
  }

  return new URL(`/sso/jwks/${encodeURIComponent(clientId)}`, getWorkOsApiOrigin());
}

function getWorkOsApiOrigin(): string {
  const protocol = process.env.WORKOS_API_HTTPS === "false" ? "http" : "https";
  const hostname = process.env.WORKOS_API_HOSTNAME || "api.workos.com";
  const port = process.env.WORKOS_API_PORT ? `:${process.env.WORKOS_API_PORT}` : "";

  return `${protocol}://${hostname}${port}`;
}

/** Test-only: reset the cached JWKS so a fresh env/client id is picked up. */
export function __resetForgeJwksCacheForTest(): void {
  jwks = null;
  jwksUrl = null;
}

// --- OIDC (self-hosted) device-bearer verification ------------------------
//
// Under AUTH_PROVIDER=oidc the bearer token is a JWT from the configured OIDC
// issuer. We verify it against the issuer's JWKS (discovered via the standard
// `/.well-known/openid-configuration` document — IdP-agnostic, no hardcoded
// Keycloak paths) and enforce BOTH the issuer and the audience. Audience
// defaults to OIDC_CLIENT_ID but is overridable via OIDC_FORGE_AUDIENCE (the
// desktop/CLI device client may present its own client id as `aud`).

// Mirrors lib/auth-provider/index.ts:isOidcProvider (AUTH_PROVIDER=oidc, case/
// space-insensitive). Inlined here rather than imported so this module never
// transitively loads the OIDC/WorkOS provider deps (AuthKit / next/headers).
function isForgeOidcProvider(): boolean {
  return (process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc";
}

let oidcJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let oidcJwksKey: string | null = null;
const oidcDiscoveryCache = new Map<string, Promise<string>>();

function requiredOidcEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ForgeAuthError("SERVER_CONFIG_ERROR", "Forge OIDC authentication is not configured.", 500, {
      failureStage: "server_config"
    });
  }
  return value;
}

function getForgeOidcAudience(): string {
  return process.env.OIDC_FORGE_AUDIENCE?.trim() || requiredOidcEnv("OIDC_CLIENT_ID");
}

/** Discover the issuer's `jwks_uri` (cached in-module per issuer). */
async function discoverOidcJwksUri(issuer: string): Promise<string> {
  let pending = oidcDiscoveryCache.get(issuer);
  if (!pending) {
    pending = (async () => {
      const discoveryUrl = new URL(
        ".well-known/openid-configuration",
        issuer.endsWith("/") ? issuer : `${issuer}/`
      );
      const response = await fetch(discoveryUrl, { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`OIDC discovery failed (${response.status})`);
      }
      const doc = (await response.json()) as { jwks_uri?: unknown };
      if (typeof doc.jwks_uri !== "string" || doc.jwks_uri.length === 0) {
        throw new Error("OIDC discovery document is missing jwks_uri");
      }
      return doc.jwks_uri;
    })().catch((error) => {
      // Don't cache a failed discovery — allow a later retry.
      oidcDiscoveryCache.delete(issuer);
      throw error;
    });
    oidcDiscoveryCache.set(issuer, pending);
  }
  return pending;
}

async function getOidcJwks(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const jwksUri = await discoverOidcJwksUri(issuer);
  if (!oidcJwks || oidcJwksKey !== jwksUri) {
    oidcJwksKey = jwksUri;
    oidcJwks = createRemoteJWKSet(new URL(jwksUri));
  }
  return oidcJwks;
}

export async function requireForgeOidcUser(request: Request): Promise<ForgeAuthenticatedUser> {
  const authorizationHeader = request.headers.get("authorization");
  const diagnostics = getForgeAuthorizationDiagnostics(authorizationHeader);
  const token = parseBearerToken(authorizationHeader);

  if (!token) {
    throw new ForgeAuthError("NOT_SIGNED_IN", "AgentKitProject sign-in is required.", 401, diagnostics);
  }

  // Surface configuration problems (500) rather than masking them as 401.
  const issuer = requiredOidcEnv("OIDC_ISSUER");
  const audience = getForgeOidcAudience();

  try {
    const jwksResolver = await getOidcJwks(issuer);
    const { payload } = await jwtVerify(token, jwksResolver, { issuer, audience });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new ForgeAuthError("INVALID_TOKEN", "The Forge authentication token is missing user identity.", 401, {
        ...diagnostics,
        failureStage: "missing_user_identity"
      });
    }

    return {
      id: payload.sub,
      email: stringClaim(payload.email),
      sessionId: stringClaim(payload.sid)
    };
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      throw error;
    }

    throw new ForgeAuthError("INVALID_TOKEN", "The Forge authentication token is invalid or expired.", 401, {
      ...diagnostics,
      failureStage: "token_verification_failed"
    });
  }
}

/** Test-only: reset cached OIDC discovery + JWKS so fresh env is picked up. */
export function __resetForgeOidcCacheForTest(): void {
  oidcJwks = null;
  oidcJwksKey = null;
  oidcDiscoveryCache.clear();
}
