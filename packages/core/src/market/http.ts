/**
 * Shared HTTP plumbing for hosted-AgentKitMarket operations.
 *
 * Pure/headless: networking goes through an injectable `fetch` (defaults to the
 * global `fetch`, Node 18+). The auth-token lifecycle is delegated to the
 * phase-1 `ensureAccessToken`/`refreshAccessToken` helpers via the supplied
 * {@link TokenStore}; this module only adds the once-on-401 refresh-and-retry
 * pattern around an already-issued token.
 *
 * Never log token values.
 */

import {
  ensureAccessToken,
  refreshAccessToken,
  ReconnectRequiredError,
  type EnsureAccessTokenOptions
} from "./auth.js";
import type { TokenStore } from "./types.js";

/** Minimal fetch surface used by the operations, for easy stubbing in tests. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Options shared by every authenticated hosted-Market operation. */
export interface MarketRequestOptions extends EnsureAccessTokenOptions {
  /** Base URL of the hosted Market (e.g. https://market.agentkitproject.com). */
  marketBaseUrl?: string;
  /** Injectable fetch, defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export const DEFAULT_MARKET_BASE_URL = "https://market.agentkitproject.com";

function resolveFetch(custom?: FetchLike): FetchLike {
  if (custom) return custom;
  if (typeof fetch === "function") {
    return fetch as unknown as FetchLike;
  }
  throw new Error("No global fetch available; pass options.fetch.");
}

/**
 * Validate + normalize the Market base URL. Honors the operator-configured
 * Market URL so self-hosted Markets work (e.g. https://market.example.com):
 * any syntactically-valid http(s) base URL is accepted and returned with
 * trailing slashes stripped. When no base URL is supplied, defaults to the
 * canonical hosted Market ({@link DEFAULT_MARKET_BASE_URL}).
 *
 * Note: the previous host-lock (canonical host only) existed as a guard so
 * device-auth bearer tokens were never sent to an arbitrary host. That guard
 * is no longer needed here: the tokenless update-check must work on self-host,
 * and on self-host the token-bearing paths are inert (device-bearer auth
 * returns 501). Operators are responsible for the URL they configure.
 */
export function normalizeMarketBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  const candidate =
    trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MARKET_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Market base URL is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Market base URL must use http or https.");
  }
  return candidate.replace(/\/+$/, "");
}

/**
 * Perform an authenticated hosted-Market request: send with the current token,
 * and if the response is 401 once, refresh the token and retry exactly once.
 * A second 401 (or a failed refresh) surfaces as {@link ReconnectRequiredError}.
 *
 * Mirrors the Rust `hosted_market_authed_request`.
 */
export async function authedRequest(
  store: TokenStore,
  options: MarketRequestOptions,
  send: (token: string) => Promise<FetchLikeResponse>
): Promise<FetchLikeResponse> {
  const token = await ensureAccessToken(store, options);
  const first = await send(token);
  if (first.status !== 401) {
    return first;
  }
  const refreshed = await refreshAccessToken(store, options);
  const second = await send(refreshed);
  if (second.status === 401) {
    throw new ReconnectRequiredError();
  }
  return second;
}

export { ReconnectRequiredError };
