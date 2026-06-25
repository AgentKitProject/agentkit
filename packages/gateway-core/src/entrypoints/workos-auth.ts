/**
 * WorkOS bearer authentication for the managed gateway (seam #2).
 *
 * The hosted managed-gateway server authenticates each caller by verifying a
 * WorkOS access token (sent as `Authorization: Bearer <token>`) against WorkOS's
 * remote JWKS and resolving the `sub` claim to a userId. This mirrors
 * `agentkitmarket-app/lib/forge-auth.ts` / `apps/auto-web/lib/forge-auth.ts`
 * `requireForgeUser`: verify the bearer as a WorkOS JWT, require `sub`.
 *
 * `jose` is imported LAZILY so this module loads cleanly in environments that
 * inject their own `authenticate` (tests / self-host), and the remote JWKS set
 * is built once and cached per client id.
 *
 * The factory takes the node:http `IncomingMessage` shape used by
 * `AuthenticateRequest` in `entrypoints/server.ts`; it returns the resolved
 * userId, or `undefined` on any failure (→ 401 at the server). It NEVER logs the
 * token.
 */

import type { IncomingMessage } from "node:http";

/** A jose-shaped remote JWKS resolver (typed structurally to avoid a hard dep). */
type JwksResolver = Parameters<typeof verifyWithJose>[1];

/** Options for the WorkOS authenticator. */
export interface WorkOsAuthOptions {
  /**
   * The WorkOS client id whose JWKS issued the tokens. Defaults to
   * `AGENTKITPROJECT_WORKOS_CLIENT_ID` then `WORKOS_CLIENT_ID` (matching the
   * device-flow client the desktop/CLI/Auto callers authenticate against).
   */
  clientId?: string;
  /** WorkOS API origin. Defaults to `https://api.workos.com`. */
  apiOrigin?: string;
  /**
   * Inject a pre-built JWKS resolver (tests). When provided, no remote JWKS is
   * fetched and `jose` is still used only to verify the token signature/claims.
   */
  jwks?: JwksResolver;
  /**
   * Inject a verifier (tests) to avoid `jose` entirely. Receives the raw token,
   * returns the decoded payload or throws.
   */
  verifyToken?: (token: string) => Promise<{ sub?: unknown }>;
}

/** Parses `Authorization: Bearer <token>` → the token, or null. */
export function parseBearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function resolveClientId(opts: WorkOsAuthOptions): string | undefined {
  return (
    opts.clientId ||
    process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID ||
    process.env.WORKOS_CLIENT_ID ||
    undefined
  );
}

function jwksUrl(opts: WorkOsAuthOptions): URL {
  const clientId = resolveClientId(opts);
  if (!clientId) {
    throw new Error("WorkOS gateway authentication is not configured (missing client id).");
  }
  const origin = opts.apiOrigin || process.env.WORKOS_API_ORIGIN || "https://api.workos.com";
  return new URL(`/sso/jwks/${encodeURIComponent(clientId)}`, origin);
}

// Cache the remote JWKS per resolved URL so we don't refetch per request.
let cachedJwks: JwksResolver | null = null;
let cachedJwksUrl: string | null = null;

async function getJwks(opts: WorkOsAuthOptions): Promise<JwksResolver> {
  if (opts.jwks) return opts.jwks;
  const url = jwksUrl(opts);
  if (!cachedJwks || cachedJwksUrl !== url.href) {
    const { createRemoteJWKSet } = await import("jose");
    cachedJwks = createRemoteJWKSet(url) as unknown as JwksResolver;
    cachedJwksUrl = url.href;
  }
  return cachedJwks;
}

/** Thin wrapper so the structural JwksResolver type can be derived from jose. */
async function verifyWithJose(
  token: string,
  jwks: import("jose").JWTVerifyGetKey,
): Promise<{ sub?: unknown }> {
  const { jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(token, jwks);
  return payload;
}

/**
 * Builds an `authenticate(req)` function for the managed gateway server. It
 * verifies the WorkOS bearer token and resolves `sub` → userId. Returns
 * `undefined` (→ 401) when the header is missing/malformed, the token fails
 * verification, or there is no `sub`.
 */
export function makeWorkOsAuthenticate(
  options: WorkOsAuthOptions = {},
): (req: IncomingMessage) => Promise<string | undefined> {
  return async (req: IncomingMessage): Promise<string | undefined> => {
    const token = parseBearerToken(req.headers["authorization"]);
    if (!token) return undefined;
    try {
      const payload = options.verifyToken
        ? await options.verifyToken(token)
        : await verifyWithJose(token, (await getJwks(options)) as import("jose").JWTVerifyGetKey);
      if (typeof payload.sub === "string" && payload.sub.length > 0) {
        return payload.sub;
      }
      return undefined;
    } catch {
      // Never log the token; any verification failure is a 401.
      return undefined;
    }
  };
}

/** Test-only: reset the cached remote JWKS so a fresh client id is picked up. */
export function __resetWorkOsJwksCacheForTest(): void {
  cachedJwks = null;
  cachedJwksUrl = null;
}
