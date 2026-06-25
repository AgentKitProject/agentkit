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
  | "missing_user_identity"
  | "provider_not_supported";

export type ForgeAuthErrorCode =
  | "NOT_SIGNED_IN"
  | "INVALID_TOKEN"
  | "SERVER_CONFIG_ERROR"
  | "NOT_SUPPORTED";

export class ForgeAuthError extends Error {
  readonly code: ForgeAuthErrorCode;
  readonly status: number;
  readonly failureStage: ForgeAuthFailureStage;
  readonly authorizationHeaderPresent: boolean;
  readonly tokenLength: number;

  constructor(
    code: ForgeAuthErrorCode,
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

// The Forge device-bearer path verifies a WorkOS-issued JWT via WorkOS' remote
// JWKS, so it is intrinsically WorkOS-bound (CLAUDE.md hard rule #4 — a SEPARATE
// auth path from the browser cookie session). Under AUTH_PROVIDER=oidc (the
// web-only self-hosted path) there is no WorkOS issuer, and the desktop Forge
// app's device flow isn't part of a self-hosted web deployment, so make this
// seam inert (501 NOT_SUPPORTED) rather than attempting WorkOS verification.
function isOidcAuthProvider(): boolean {
  return (process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc";
}

export async function requireForgeUser(request: Request): Promise<ForgeAuthenticatedUser> {
  if (isOidcAuthProvider()) {
    throw new ForgeAuthError(
      "NOT_SUPPORTED",
      "Forge device authentication is not available on this deployment.",
      501,
      { failureStage: "provider_not_supported" }
    );
  }
  return requireForgeBearerUser(request);
}

export async function requireForgeBearerUser(request: Request): Promise<ForgeAuthenticatedUser> {
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

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseBearerToken(value: string | null) {
  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export function getForgeAuthorizationDiagnostics(value: string | null) {
  const token = parseBearerToken(value);

  return {
    authorizationHeaderPresent: Boolean(value),
    tokenLength: token?.length ?? 0,
    failureStage: !value ? "missing_header" : token ? "token_verification_failed" : "malformed_header"
  } satisfies {
    authorizationHeaderPresent: boolean;
    tokenLength: number;
    failureStage: ForgeAuthFailureStage;
  };
}

function getJwks() {
  const url = getWorkOsJwksUrl();

  if (!jwks || jwksUrl !== url.href) {
    jwksUrl = url.href;
    jwks = createRemoteJWKSet(url);
  }

  return jwks;
}

function getWorkOsJwksUrl() {
  const clientId = process.env.WORKOS_CLIENT_ID;

  if (!clientId) {
    throw new ForgeAuthError("SERVER_CONFIG_ERROR", "Forge authentication is not configured.", 500, {
      failureStage: "server_config"
    });
  }

  return new URL(`/sso/jwks/${encodeURIComponent(clientId)}`, getWorkOsApiOrigin());
}

function getWorkOsApiOrigin() {
  const protocol = process.env.WORKOS_API_HTTPS === "false" ? "http" : "https";
  const hostname = process.env.WORKOS_API_HOSTNAME || "api.workos.com";
  const port = process.env.WORKOS_API_PORT ? `:${process.env.WORKOS_API_PORT}` : "";

  return `${protocol}://${hostname}${port}`;
}
