// AgentKitAuto — OAuth connection flow (gdrive / dropbox), AUTO-WEB ONLY.
//
// Browser flow: GET /api/auto/connections/oauth/[provider]/start (authed) sets
// a short-lived state cookie and 302s to the provider's consent screen; the
// provider redirects back to .../callback where the state is checked and the
// code is exchanged SERVER-SIDE (auto-core's exchangeOAuthCode). The resulting
// token set is stored ONLY in the SecretStore (S2) — the connection record
// carries the opaque secretRef and tokens never appear in any response.
//
// BYO-config: provider app credentials come from OAUTH_GDRIVE_CLIENT_ID/SECRET
// and OAUTH_DROPBOX_CLIENT_ID/SECRET (auto-core's loadOAuthClientConfig);
// unconfigured → the routes return 501.

import {
  exchangeOAuthCode,
  loadOAuthClientConfig,
  serializeOAuthTokenSet,
  SecretStoreUnconfiguredError,
  type Connection,
  type FetchFn,
  type OAuthProvider,
} from "@agentkitforge/auto-core";
import { randomBytes } from "node:crypto";
import { getAppUrl } from "@/lib/url-config";
import { AutoValidationError } from "@/server/core/auto";
import { getEventStorage } from "@/server/core/auto-events";

/** Short-lived state cookie for the in-flight OAuth transaction (10 min),
 *  mirroring lib/auth-provider/oidc-provider.ts's TX cookies. */
export const AUTO_OAUTH_STATE_COOKIE = "auto-oauth-state";
export const AUTO_OAUTH_STATE_MAX_AGE = 600;

/** Human-readable default connection names per provider. */
const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  gdrive: "Google Drive",
  dropbox: "Dropbox",
};

/** The canonical redirect URI for a provider's callback route. */
export function oauthRedirectUri(provider: OAuthProvider): string {
  const base = getAppUrl().replace(/\/$/, "");
  return `${base}/api/auto/connections/oauth/${encodeURIComponent(provider)}/callback`;
}

/** Random URL-safe state nonce for the transaction cookie. */
export function generateOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

/** Global fetch adapted to auto-core's injected FetchFn shape. */
const globalFetchFn: FetchFn = async (url, init) => {
  const res = await fetch(url, init as RequestInit | undefined);
  return {
    status: res.status,
    headers: { forEach: (cb: (value: string, key: string) => void) => res.headers.forEach(cb) },
    text: () => res.text(),
  };
};

interface OAuthOverrides {
  fetchImpl?: FetchFn;
}

let oauthOverrides: OAuthOverrides = {};

/** Test seam: inject the token-exchange fetch (offline tests). */
export function setAutoOAuthOverridesForTests(overrides: OAuthOverrides): void {
  oauthOverrides = overrides;
}

/**
 * Exchanges the authorization code server-side and creates the OAuth-backed
 * connection: token set → SecretStore (opaque secretRef), connection record
 * (ownerType user, status ok, non-secret config only). Tokens NEVER appear in
 * the return value beyond the record's opaque ref (S2).
 */
export async function completeOAuthConnection(args: {
  userId: string;
  provider: OAuthProvider;
  code: string;
}): Promise<Connection> {
  const { userId, provider, code } = args;
  const config = loadOAuthClientConfig(provider);
  if (!config) {
    throw new AutoValidationError(`${provider} is not configured on this instance.`);
  }
  const tokens = await exchangeOAuthCode({
    provider,
    config,
    code,
    redirectUri: oauthRedirectUri(provider),
    fetchImpl: oauthOverrides.fetchImpl ?? globalFetchFn,
    now: () => new Date().toISOString(),
  });

  const events = await getEventStorage();
  let secretRef: string;
  try {
    secretRef = await events.secrets.put(serializeOAuthTokenSet(tokens));
  } catch (err) {
    if (err instanceof SecretStoreUnconfiguredError || (err as Error)?.name === "SecretStoreUnconfiguredError") {
      throw new AutoValidationError(
        "Secret storage is not configured on this instance (set AUTO_SECRET_ENCRYPTION_KEY).",
      );
    }
    throw err;
  }

  const connection = await events.connections.createConnection({
    ownerType: "user",
    ownerId: userId,
    name: PROVIDER_LABELS[provider],
    type: provider,
    config: {},
    secretRef,
    createdAt: new Date().toISOString(),
  });
  // The exchange succeeded moments ago — the connection is verifiably live.
  await events.connections.setConnectionStatus(connection.id, "ok", new Date().toISOString());
  return (await events.connections.getConnection(connection.id)) ?? { ...connection, status: "ok" };
}
