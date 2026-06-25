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
  // Device-auth (WorkOS BEARER) is WorkOS-bound and unused for web-only
  // self-hosted instances. Under AUTH_PROVIDER=oidc the whole /api/forge/*
  // device-bearer surface is inert: return a clean 501 rather than attempting a
  // WorkOS JWKS verification that cannot succeed. Hosted (workos) is unchanged.
  if ((process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc") {
    throw new ForgeAuthError(
      "NOT_SUPPORTED",
      "Forge device authentication is not available on this self-hosted instance.",
      501,
      { failureStage: "server_config", authorizationHeaderPresent: false, tokenLength: 0 }
    );
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
