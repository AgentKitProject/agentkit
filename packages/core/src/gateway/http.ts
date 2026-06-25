/**
 * HTTP plumbing for the hosted-AgentKitForge Gateway client.
 *
 * The gateway lets NON-browser clients (desktop / CLI / Auto) run an Agent Kit
 * through the hosted, managed-billing inference loop. It mirrors the
 * `src/market/*` conventions — injectable `fetch`, device-auth bearer via the
 * shared {@link TokenStore}, once-on-401 refresh-and-retry — but adds a
 * STREAMING fetch surface because turn/tool-result responses are SSE bodies.
 *
 * Never log token values.
 */

import {
  ensureAccessToken,
  refreshAccessToken,
  ReconnectRequiredError,
  type EnsureAccessTokenOptions
} from "../market/auth.js";
import type { FetchLike, FetchLikeResponse } from "../market/http.js";
import type { TokenStore } from "../market/types.js";

export type { FetchLike, FetchLikeResponse };
export { ReconnectRequiredError };

/** The default hosted web-Forge host that fronts the gateway routes. */
export const DEFAULT_GATEWAY_BASE_URL = "https://forge.agentkitproject.com";

/**
 * A fetch surface that exposes the streaming response body. The buffered
 * {@link FetchLike} used by the market client cannot stream SSE, so the gateway
 * client requires a fetch whose response carries a `ReadableStream` body (the
 * standard WHATWG `fetch`).
 */
export type StreamingFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<StreamingFetchResponse>;

export interface StreamingFetchResponse {
  status: number;
  ok: boolean;
  /** WHATWG streaming body; null for empty responses. */
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Options shared by every authenticated gateway operation. */
export interface GatewayRequestOptions extends EnsureAccessTokenOptions {
  /** Base URL of the hosted web Forge that fronts the gateway. */
  gatewayBaseUrl?: string;
  /** Injectable streaming fetch; defaults to the global `fetch`. */
  fetch?: StreamingFetchLike;
}

/** Forge ↔ Gateway (Seam) route builders — device-auth bearer. */
export const forgeGatewayRoutes = {
  /** POST: create a managed-billing gateway session. */
  sessions: (): string => "/api/forge/gateway/sessions",
  /** POST (SSE): send user input and run a turn. */
  turn: (sessionId: string): string =>
    `/api/forge/gateway/sessions/${encodeURIComponent(sessionId)}/turn`,
  /** POST (SSE): submit local tool results to resume the loop. */
  toolResult: (sessionId: string): string =>
    `/api/forge/gateway/sessions/${encodeURIComponent(sessionId)}/tool-result`,
  /** DELETE: tear down a gateway session. */
  session: (sessionId: string): string =>
    `/api/forge/gateway/sessions/${encodeURIComponent(sessionId)}`
} as const;

/**
 * Normalize the gateway base URL. Accepts any https URL (the hosted/self-hosted
 * web Forge host is configurable, unlike the single hosted-Market host) and
 * strips a trailing slash so route concatenation is clean.
 */
export function normalizeGatewayBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  const candidate = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_GATEWAY_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Gateway base URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Gateway base URL must use HTTPS.");
  }
  return candidate.replace(/\/+$/, "");
}

/** Thrown when the gateway reports 402 — the account has no usable balance. */
export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  /** Optional extra fields the server attached to the 402 body. */
  readonly details?: Record<string, unknown>;
  constructor(message?: string, details?: Record<string, unknown>) {
    super(
      message ??
        "Insufficient credits to run this kit through the hosted gateway."
    );
    this.name = "InsufficientCreditsError";
    this.details = details;
  }
}

function resolveStreamingFetch(custom?: StreamingFetchLike): StreamingFetchLike {
  if (custom) return custom;
  if (typeof fetch === "function") {
    return fetch as unknown as StreamingFetchLike;
  }
  throw new Error("No global fetch available; pass options.fetch.");
}

/**
 * Inspect a response for the 402 insufficient-credits condition and throw the
 * typed {@link InsufficientCreditsError}. Safe to call before reading the body
 * for the success path. No-op when the status is not 402.
 */
export async function throwIfInsufficientCredits(
  response: { status: number; text(): Promise<string>; json(): Promise<unknown> }
): Promise<void> {
  if (response.status !== 402) return;
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message : undefined;
  throw new InsufficientCreditsError(message, body);
}

/**
 * Perform an authenticated gateway request with the streaming fetch: send with
 * the current token, and on a single 401 refresh once and retry. A second 401
 * (or a failed refresh) surfaces as {@link ReconnectRequiredError}. Mirrors the
 * market `authedRequest`, but preserves the streaming response body.
 */
export async function authedStreamingRequest(
  store: TokenStore,
  options: GatewayRequestOptions,
  send: (token: string) => Promise<StreamingFetchResponse>
): Promise<StreamingFetchResponse> {
  const token = await ensureAccessToken(store, options);
  const first = await send(token);
  if (first.status !== 401) return first;
  const refreshed = await refreshAccessToken(store, options);
  const second = await send(refreshed);
  if (second.status === 401) throw new ReconnectRequiredError();
  return second;
}

export { resolveStreamingFetch };
