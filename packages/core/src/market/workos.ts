/**
 * WorkOS device-authorization request building + parsing, ported from
 * `account_auth.rs`. The request builders are PURE (no network) so they can be
 * unit-tested for the critical `offline_access` scope; the executor uses global
 * `fetch` (Node 18+).
 */

import type { WorkosUser } from "./types.js";

export const WORKOS_DEVICE_AUTH_URL =
  "https://api.workos.com/user_management/authorize/device";
export const WORKOS_DEVICE_TOKEN_URL =
  "https://api.workos.com/user_management/authenticate";

export const DEVICE_CODE_GRANT =
  "urn:ietf:params:oauth:grant-type:device_code";

/**
 * WorkOS User Management issues a refresh token only when `offline_access` is
 * requested. Without it, every access token expires (~5 min) with no way to
 * refresh — this was a real bug; the scope guard test protects the fix.
 */
export const WORKOS_DEVICE_AUTH_SCOPE = "openid profile email offline_access";

export const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
export const MAX_DEVICE_INTERVAL_SECONDS = 30;

/** Optional knobs for the WorkOS endpoints (tests/self-hosting override these). */
export interface WorkosConfig {
  clientId: string;
  deviceAuthUrl?: string;
  tokenUrl?: string;
}

export interface WorkosHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** URL-encoded form body. */
  body: string;
}

function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

/** PURE: build the device-authorization request (includes `offline_access`). */
export function buildDeviceAuthorizationRequest(
  config: WorkosConfig
): WorkosHttpRequest {
  return {
    url: config.deviceAuthUrl ?? WORKOS_DEVICE_AUTH_URL,
    method: "POST",
    headers: { ...FORM_HEADERS },
    body: formBody({
      client_id: config.clientId,
      scope: WORKOS_DEVICE_AUTH_SCOPE
    })
  };
}

/** PURE: build the device-code token poll request. */
export function buildDeviceTokenRequest(
  config: WorkosConfig,
  deviceCode: string
): WorkosHttpRequest {
  return {
    url: config.tokenUrl ?? WORKOS_DEVICE_TOKEN_URL,
    method: "POST",
    headers: { ...FORM_HEADERS },
    body: formBody({
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: config.clientId
    })
  };
}

/** PURE: build the refresh-token request. */
export function buildRefreshTokenRequest(
  config: WorkosConfig,
  refreshToken: string
): WorkosHttpRequest {
  return {
    url: config.tokenUrl ?? WORKOS_DEVICE_TOKEN_URL,
    method: "POST",
    headers: { ...FORM_HEADERS },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId
    })
  };
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenResponse {
  accessToken: string;
  refreshToken?: string;
  user?: WorkosUser;
}

function clampInterval(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw)
    ? raw
    : DEFAULT_DEVICE_INTERVAL_SECONDS;
  return Math.min(
    Math.max(value, DEFAULT_DEVICE_INTERVAL_SECONDS),
    MAX_DEVICE_INTERVAL_SECONDS
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseUser(raw: unknown): WorkosUser | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    id: asString(r.id),
    email: asString(r.email),
    firstName: asString(r.first_name) ?? asString(r.firstName),
    lastName: asString(r.last_name) ?? asString(r.lastName),
    profilePictureUrl:
      asString(r.profile_picture_url) ?? asString(r.profilePictureUrl),
    metadata:
      typeof r.metadata === "object" && r.metadata !== null
        ? (r.metadata as Record<string, unknown>)
        : undefined
  };
}

/** PURE: parse a device-authorization JSON body, applying interval clamping. */
export function parseDeviceAuthorizationResponse(
  body: unknown
): DeviceAuthorizationResponse {
  if (typeof body !== "object" || body === null) {
    throw new Error("AgentKitProject device login response was invalid.");
  }
  const r = body as Record<string, unknown>;
  const deviceCode = asString(r.device_code);
  const userCode = asString(r.user_code);
  const verificationUri = asString(r.verification_uri);
  const expiresIn = typeof r.expires_in === "number" ? r.expires_in : undefined;
  if (!deviceCode || !userCode || !verificationUri || expiresIn === undefined) {
    throw new Error("AgentKitProject device login response was invalid.");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: asString(r.verification_uri_complete),
    expiresIn,
    interval: clampInterval(r.interval)
  };
}

/** PURE: parse a device-token / refresh JSON body. */
export function parseDeviceTokenResponse(body: unknown): DeviceTokenResponse {
  if (typeof body !== "object" || body === null) {
    throw new Error("AgentKitProject login response was invalid.");
  }
  const r = body as Record<string, unknown>;
  const accessToken = asString(r.access_token);
  if (!accessToken) {
    throw new Error("AgentKitProject login response did not include a usable access token.");
  }
  return {
    accessToken,
    refreshToken: asString(r.refresh_token),
    user: parseUser(r.user)
  };
}
