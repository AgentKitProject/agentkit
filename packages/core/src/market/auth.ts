/**
 * Headless WorkOS device-flow auth + proactive refresh, ported from
 * `account_auth.rs`. Networking uses global `fetch` (Node 18+); no Tauri, no
 * GUI. The storage backend is dependency-injected via {@link TokenStore} so the
 * desktop app can later supply its Rust-backed secure store.
 *
 * Never log token values.
 */

import {
  ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
  decodeJwtExp,
  epochSeconds,
  tokenNeedsRefresh
} from "./jwt.js";
import type { StoredSession, TokenStore, WorkosUser } from "./types.js";
import {
  buildDeviceAuthorizationRequest,
  buildDeviceTokenRequest,
  buildRefreshTokenRequest,
  parseDeviceAuthorizationResponse,
  parseDeviceTokenResponse,
  type DeviceAuthorizationResponse,
  type WorkosConfig
} from "./workos.js";

export const RECONNECT_REQUIRED_ERROR =
  "RECONNECT_REQUIRED: Reconnect AgentKitProject account to download directly from hosted AgentKitMarket.";

/** Thrown when the session is missing/unusable and the user must reconnect. */
export class ReconnectRequiredError extends Error {
  constructor(message: string = RECONNECT_REQUIRED_ERROR) {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

/** The verification prompt the caller surfaces to the user (URL + code). */
export interface DeviceLoginPrompt {
  userCode: string;
  verificationUri: string;
  /** URL with the code pre-filled, when WorkOS provides it. */
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface LoginOptions extends WorkosConfig {
  /**
   * Called once the device code is issued, so a CLI/host can show the URL and
   * code (and optionally open a browser). This is how the verification details
   * reach the user in a headless flow.
   */
  onPrompt?: (prompt: DeviceLoginPrompt) => void | Promise<void>;
  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Injectable clock (seconds), for tests. Defaults to wall clock. */
  now?: () => number;
  /** Injectable sleep, for tests. Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoginResult {
  user?: WorkosUser;
  session: StoredSession;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(
  request: { url: string; method: string; headers: Record<string, string>; body: string },
  timeoutMs: number
): Promise<{ status: number; ok: boolean; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return "authorization_failed";
}

/**
 * Run the full WorkOS device-authorization flow: request a device code, surface
 * the verification URL/code via `onPrompt`, poll until the user approves, then
 * persist the resulting session. Returns the connected user + stored session.
 */
export async function login(
  options: LoginOptions,
  store: TokenStore
): Promise<LoginResult> {
  const now = options.now ?? epochSeconds;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const config: WorkosConfig = {
    clientId: options.clientId,
    deviceAuthUrl: options.deviceAuthUrl,
    tokenUrl: options.tokenUrl
  };

  const authResult = await fetchJson(
    buildDeviceAuthorizationRequest(config),
    timeoutMs
  );
  if (!authResult.ok) {
    throw new Error(
      `AgentKitProject device login could not start. Status: ${authResult.status}.`
    );
  }
  const authorization: DeviceAuthorizationResponse =
    parseDeviceAuthorizationResponse(authResult.json);

  if (options.onPrompt) {
    await options.onPrompt({
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
      expiresIn: authorization.expiresIn,
      interval: authorization.interval
    });
  }

  const expiresAt = now() + authorization.expiresIn;
  let interval = authorization.interval;

  while (now() < expiresAt) {
    const poll = await fetchJson(
      buildDeviceTokenRequest(config, authorization.deviceCode),
      timeoutMs
    );
    if (poll.ok) {
      const token = parseDeviceTokenResponse(poll.json);
      const session: StoredSession = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        user: token.user,
        connectedAt: new Date().toISOString()
      };
      await store.set(session);
      return { user: token.user, session };
    }

    const code = errorCode(poll.json);
    switch (code) {
      case "authorization_pending":
        await sleep(interval * 1000);
        break;
      case "slow_down":
        interval = Math.min(interval + 5, 30);
        await sleep(interval * 1000);
        break;
      case "access_denied":
        throw new Error("AgentKitProject login was cancelled or denied.");
      case "expired_token":
        throw new Error("AgentKitProject login expired. Please try again.");
      case "invalid_client":
        throw new Error(
          "AgentKitProject login is not configured for this build."
        );
      default:
        throw new Error(
          `AgentKitProject login failed. Status: ${poll.status}.`
        );
    }
  }

  throw new Error("AgentKitProject login timed out. Please try again.");
}

/** Clear the stored session. Always best-effort; never throws on missing data. */
export async function logout(store: TokenStore): Promise<void> {
  await store.clear();
}

export interface RefreshOptions extends WorkosConfig {
  timeoutMs?: number;
}

/**
 * Exchange the stored refresh token for a fresh access token, persisting the
 * rotated access+refresh tokens. Throws {@link ReconnectRequiredError} when no
 * refresh token is stored or WorkOS rejects the refresh (4xx). Network/5xx
 * failures throw a descriptive error WITHOUT touching the stored session.
 */
export async function refreshAccessToken(
  store: TokenStore,
  options: RefreshOptions
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const session = await store.get();
  if (!session) throw new ReconnectRequiredError();
  const refreshToken = session.refreshToken?.trim();
  if (!refreshToken) throw new ReconnectRequiredError();

  const config: WorkosConfig = {
    clientId: options.clientId,
    deviceAuthUrl: options.deviceAuthUrl,
    tokenUrl: options.tokenUrl
  };
  const result = await fetchJson(
    buildRefreshTokenRequest(config, refreshToken),
    timeoutMs
  );
  if (result.status >= 400 && result.status < 500) {
    throw new ReconnectRequiredError();
  }
  if (!result.ok) {
    throw new Error(
      `AgentKitProject session refresh failed. Status: ${result.status}.`
    );
  }
  const refreshed = parseDeviceTokenResponse(result.json);

  const rotated: StoredSession = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? session.refreshToken,
    user: refreshed.user ?? session.user,
    connectedAt: new Date().toISOString()
  };
  await store.set(rotated);
  return rotated.accessToken;
}

export interface EnsureAccessTokenOptions extends WorkosConfig {
  timeoutMs?: number;
  now?: () => number;
  bufferSeconds?: number;
}

/**
 * Return a still-valid access token for hosted-Market calls, refreshing it
 * proactively when it is expired or within the refresh buffer of expiry.
 *
 * Throws {@link ReconnectRequiredError} when there is no usable session, or when
 * a needed refresh is rejected by WorkOS.
 */
export async function ensureAccessToken(
  store: TokenStore,
  options: EnsureAccessTokenOptions
): Promise<string> {
  const now = options.now ?? epochSeconds;
  const buffer = options.bufferSeconds ?? ACCESS_TOKEN_REFRESH_BUFFER_SECONDS;
  const session = await store.get();
  if (!session || session.accessToken.trim() === "") {
    throw new ReconnectRequiredError();
  }
  if (tokenNeedsRefresh(decodeJwtExp(session.accessToken), now(), buffer)) {
    return refreshAccessToken(store, options);
  }
  return session.accessToken;
}
