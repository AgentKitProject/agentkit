/**
 * OAuth connection MECHANISM (Drive `drive.file` + Dropbox) — BYO-config.
 *
 * The hosted deployment sets the provider app credentials via env; self-host
 * operators bring their own; when the env is absent the provider is "not
 * configured on this instance" (the web layer returns 501). This module is
 * pure mechanism: authorization-URL building, the server-side code exchange,
 * and refresh — every network call goes through an INJECTED fetch so tests
 * stay offline.
 *
 * S2 (absolute): token sets are stored ONLY via the SecretStore (an opaque
 * `secretRef` on the connection). Reveal/refresh happens in the WORKER HARNESS
 * / app servers — never anywhere an agent can reach.
 */

import type { FetchFn } from "./http-fetch.js";
import type { ConnectionRepository, SecretStore } from "./ports.js";
import type { Connection } from "./types.js";

/** The OAuth-backed connection providers. */
export type OAuthProvider = "gdrive" | "dropbox";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["gdrive", "dropbox"];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** Env var names carrying the per-provider app credentials (BYO-config). */
export const OAUTH_ENV_VARS: Record<OAuthProvider, { clientId: string; clientSecret: string }> = {
  gdrive: { clientId: "OAUTH_GDRIVE_CLIENT_ID", clientSecret: "OAUTH_GDRIVE_CLIENT_SECRET" },
  dropbox: { clientId: "OAUTH_DROPBOX_CLIENT_ID", clientSecret: "OAUTH_DROPBOX_CLIENT_SECRET" },
};

/** Per-provider endpoints + scopes (mechanism constants, not secrets). */
export const OAUTH_PROVIDER_SETTINGS: Record<
  OAuthProvider,
  {
    authUrl: string;
    tokenUrl: string;
    scope: string;
    /** Extra authorize-URL params (offline access etc.). */
    extraAuthParams: Record<string, string>;
  }
> = {
  gdrive: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Least-privilege: drive.file = only files the app creates/opens.
    scope: "https://www.googleapis.com/auth/drive.file",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  dropbox: {
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scope: "files.content.write files.content.read",
    extraAuthParams: { token_access_type: "offline" },
  },
};

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/** The per-deployment provider credentials (absent = not configured → 501). */
export type OAuthProvidersConfig = Partial<Record<OAuthProvider, OAuthClientConfig>>;

/** Reads the provider app credentials from the environment (BYO-config). */
export function loadOAuthClientConfig(
  provider: OAuthProvider,
  env: Record<string, string | undefined> = process.env,
): OAuthClientConfig | undefined {
  const names = OAUTH_ENV_VARS[provider];
  const clientId = env[names.clientId]?.trim();
  const clientSecret = env[names.clientSecret]?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/** Reads every configured provider from the environment. */
export function loadOAuthProvidersConfig(
  env: Record<string, string | undefined> = process.env,
): OAuthProvidersConfig {
  const config: OAuthProvidersConfig = {};
  for (const provider of OAUTH_PROVIDERS) {
    const c = loadOAuthClientConfig(provider, env);
    if (c) config[provider] = c;
  }
  return config;
}

/** Builds the provider authorization URL (302 target of the /start route). */
export function buildOAuthAuthorizationUrl(args: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const settings = OAUTH_PROVIDER_SETTINGS[args.provider];
  const url = new URL(settings.authUrl);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", settings.scope);
  url.searchParams.set("state", args.state);
  for (const [k, v] of Object.entries(settings.extraAuthParams)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * The token material stored (JSON) behind the connection's secretRef. Always
 * SecretStore-encrypted; never on the connection record (S2).
 */
export interface OAuthTokenSet {
  accessToken: string;
  /** Absent when the provider issued no refresh token. */
  refreshToken?: string;
  /** ISO expiry of accessToken; absent = no known expiry. */
  expiresAt?: string;
}

export function serializeOAuthTokenSet(tokens: OAuthTokenSet): string {
  return JSON.stringify({
    access_token: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refresh_token: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiry: tokens.expiresAt } : {}),
  });
}

export function parseOAuthTokenSet(plaintext: string): OAuthTokenSet {
  const raw = JSON.parse(plaintext) as Record<string, unknown>;
  const accessToken = raw["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Stored OAuth token set carries no access_token.");
  }
  return {
    accessToken,
    ...(typeof raw["refresh_token"] === "string" ? { refreshToken: raw["refresh_token"] } : {}),
    ...(typeof raw["expiry"] === "string" ? { expiresAt: raw["expiry"] } : {}),
  };
}

/** Expiry check with a 60s skew (an about-to-expire token counts as expired). */
export function isOAuthTokenExpired(tokens: OAuthTokenSet, nowISO: string, skewMs = 60_000): boolean {
  if (!tokens.expiresAt) return false;
  const expiresMs = Date.parse(tokens.expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  return Date.parse(nowISO) + skewMs >= expiresMs;
}

/** Raised when a provider token endpoint refuses the exchange/refresh. */
export class OAuthExchangeError extends Error {
  readonly name = "OAuthExchangeError";
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postTokenEndpoint(args: {
  provider: OAuthProvider;
  params: Record<string, string>;
  fetchImpl: FetchFn;
  now: () => string;
}): Promise<OAuthTokenSet> {
  const settings = OAUTH_PROVIDER_SETTINGS[args.provider];
  const body = new URLSearchParams(args.params).toString();
  const res = await args.fetchImpl(settings.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    // Never echo the response body verbatim into errors that might carry
    // tokens; providers return machine error codes, keep it short.
    throw new OAuthExchangeError(
      `${args.provider} token endpoint responded with HTTP ${res.status}.`,
    );
  }
  let parsed: TokenEndpointResponse;
  try {
    parsed = JSON.parse(text) as TokenEndpointResponse;
  } catch {
    throw new OAuthExchangeError(`${args.provider} token endpoint returned invalid JSON.`);
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new OAuthExchangeError(`${args.provider} token endpoint returned no access_token.`);
  }
  const expiresAt =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
      ? new Date(Date.parse(args.now()) + parsed.expires_in * 1000).toISOString()
      : undefined;
  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? { refreshToken: parsed.refresh_token }
      : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/** Server-side authorization-code exchange (the /callback route). */
export async function exchangeOAuthCode(args: {
  provider: OAuthProvider;
  config: OAuthClientConfig;
  code: string;
  redirectUri: string;
  fetchImpl: FetchFn;
  now: () => string;
}): Promise<OAuthTokenSet> {
  return postTokenEndpoint({
    provider: args.provider,
    params: {
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.config.clientId,
      client_secret: args.config.clientSecret,
      redirect_uri: args.redirectUri,
    },
    fetchImpl: args.fetchImpl,
    now: args.now,
  });
}

/** Refresh-token grant (per-provider token endpoint). */
export async function refreshOAuthToken(args: {
  provider: OAuthProvider;
  config: OAuthClientConfig;
  refreshToken: string;
  fetchImpl: FetchFn;
  now: () => string;
}): Promise<OAuthTokenSet> {
  const refreshed = await postTokenEndpoint({
    provider: args.provider,
    params: {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.config.clientId,
      client_secret: args.config.clientSecret,
    },
    fetchImpl: args.fetchImpl,
    now: args.now,
  });
  // Providers often omit refresh_token on refresh — keep the original.
  return { refreshToken: args.refreshToken, ...refreshed };
}

/**
 * Resolves a FRESH access token for an OAuth-backed connection: reveals the
 * stored token set, refreshes it when expired (rotating the stored secret —
 * new ref put, connection updated, old ref deleted best-effort). SERVER/WORKER
 * ONLY (S2). Throws when the connection has no stored secret or refresh fails.
 */
export async function ensureFreshOAuthToken(args: {
  connection: Connection;
  provider: OAuthProvider;
  config: OAuthClientConfig;
  secrets: SecretStore;
  connections: ConnectionRepository;
  fetchImpl: FetchFn;
  now: () => string;
}): Promise<string> {
  const { connection, provider, config, secrets, connections, fetchImpl, now } = args;
  const secretRef = connection.secretRef;
  if (!secretRef) {
    throw new Error(`Connection ${connection.id} has no stored OAuth token.`);
  }
  const tokens = parseOAuthTokenSet(await secrets.reveal(secretRef));
  if (!isOAuthTokenExpired(tokens, now())) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) {
    throw new Error(`Connection ${connection.id}'s OAuth token expired and no refresh token is stored.`);
  }
  const refreshed = await refreshOAuthToken({
    provider,
    config,
    refreshToken: tokens.refreshToken,
    fetchImpl,
    now,
  });
  const newRef = await secrets.put(serializeOAuthTokenSet(refreshed));
  await connections.updateConnection(connection.id, { secretRef: newRef });
  try {
    await secrets.delete(secretRef);
  } catch {
    /* best-effort — an orphaned ciphertext row is harmless */
  }
  return refreshed.accessToken;
}
