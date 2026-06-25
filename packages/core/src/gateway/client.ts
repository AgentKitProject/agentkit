/**
 * Low-level hosted-Gateway client: the four transport methods that map 1:1 to
 * the Phase 2c-i gateway routes. These do device-auth + SSE parsing only; the
 * tool-use loop lives in the high-level driver ({@link runAgentKitWithGateway}).
 *
 * Never log token values.
 */

import {
  authedStreamingRequest,
  forgeGatewayRoutes,
  normalizeGatewayBaseUrl,
  resolveStreamingFetch,
  throwIfInsufficientCredits,
  type GatewayRequestOptions,
  type StreamingFetchResponse
} from "./http.js";
import { SseParser, type GatewayStreamEvent } from "./sse.js";
import type { TokenStore } from "../market/types.js";

/** A tool the kit may invoke, in Anthropic tool-definition shape. */
export interface GatewayToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** A tool_use the model emitted during a turn; the caller executes it locally. */
export interface GatewayToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

/** The result of a locally-executed tool, posted back to resume the loop. */
export interface GatewayToolResult {
  toolUseId: string;
  /** Success payload (string or JSON-serializable). Mutually exclusive with `error`. */
  result?: unknown;
  /** Error string when the tool failed. Mutually exclusive with `result`. */
  error?: string;
}

/** The terminal outcome of a single streamed turn. */
export interface TurnOutcome {
  stopReason: string;
  /** Usage object from the final `usage` event, if any. */
  usage?: Record<string, unknown>;
  /** tool_use calls emitted this turn (present when stopReason is "tool_use"). */
  toolUses: GatewayToolUse[];
}

export interface CreateGatewaySessionOptions extends GatewayRequestOptions {
  /** System prompt OR rendered kit context; at least one is required server-side. */
  systemPrompt?: string;
  kitContext?: string;
  tools: GatewayToolDefinition[];
  model: string;
  /** Billing mode; only "managed" is supported for hosted gateway today. */
  billing?: "managed";
}

/** Create a managed-billing gateway session. Returns the server-owned id. */
export async function createGatewaySession(
  store: TokenStore,
  options: CreateGatewaySessionOptions
): Promise<string> {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(options.gatewayBaseUrl);
  const reqOptions: GatewayRequestOptions = { ...options, gatewayBaseUrl };
  const fetchImpl = resolveStreamingFetch(options.fetch);
  const endpoint = gatewayBaseUrl + forgeGatewayRoutes.sessions();

  const body: Record<string, unknown> = {
    tools: options.tools,
    model: options.model,
    billing: options.billing ?? "managed"
  };
  if (typeof options.systemPrompt === "string") body.systemPrompt = options.systemPrompt;
  if (typeof options.kitContext === "string") body.kitContext = options.kitContext;

  const response = await authedStreamingRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    })
  );

  await throwIfInsufficientCredits(response);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gateway could not create a session. Status: ${response.status}.${text ? ` ${text}` : ""}`
    );
  }
  const parsed = (await response.json()) as { sessionId?: string };
  const sessionId = parsed.sessionId?.trim();
  if (!sessionId) {
    throw new Error("Gateway did not return a session id.");
  }
  return sessionId;
}

export interface StreamTurnOptions extends GatewayRequestOptions {
  sessionId: string;
  input: string;
}

export interface SubmitToolResultsOptions extends GatewayRequestOptions {
  sessionId: string;
  results: GatewayToolResult[];
}

/** Read an SSE response body, dispatching normalized events to `onEvent`. */
async function consumeStream(
  response: StreamingFetchResponse,
  onEvent?: (event: GatewayStreamEvent) => void
): Promise<TurnOutcome> {
  await throwIfInsufficientCredits(response);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gateway turn failed. Status: ${response.status}.${text ? ` ${text}` : ""}`
    );
  }
  if (!response.body) {
    throw new Error("Gateway returned an empty stream body.");
  }

  const parser = new SseParser();
  const decoder = new TextDecoder();
  const toolUses: GatewayToolUse[] = [];
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let errorEvent: GatewayStreamEvent | undefined;

  const reader = response.body.getReader();
  const handle = (event: GatewayStreamEvent): void => {
    if (onEvent) onEvent(event);
    switch (event.type) {
      case "tool_use": {
        const e = event as { toolUseId: string; name: string; input: unknown };
        toolUses.push({ toolUseId: e.toolUseId, name: e.name, input: e.input });
        break;
      }
      case "usage":
        usage = event as Record<string, unknown>;
        break;
      case "done":
        stopReason = (event as { stopReason?: string }).stopReason;
        break;
      case "error":
        errorEvent = event;
        break;
      default:
        break;
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        handle(event);
      }
    }
    if (done) break;
  }
  for (const event of parser.flush()) handle(event);

  if (errorEvent) {
    const msg =
      (errorEvent as { message?: string }).message ?? "Gateway stream reported an error.";
    throw new Error(msg);
  }
  if (stopReason === undefined) {
    throw new Error("Gateway stream ended without a terminal stop reason.");
  }
  return { stopReason, usage, toolUses };
}

/**
 * Send user input and stream the turn. Parses the SSE body chunk-boundary-safe,
 * emits normalized events to `onEvent`, and returns the terminal outcome
 * (stopReason, usage, and any tool_use calls to execute).
 */
export async function streamTurn(
  store: TokenStore,
  options: StreamTurnOptions,
  onEvent?: (event: GatewayStreamEvent) => void
): Promise<TurnOutcome> {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(options.gatewayBaseUrl);
  const reqOptions: GatewayRequestOptions = { ...options, gatewayBaseUrl };
  const fetchImpl = resolveStreamingFetch(options.fetch);
  const endpoint = gatewayBaseUrl + forgeGatewayRoutes.turn(options.sessionId);

  const response = await authedStreamingRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({ input: options.input })
    })
  );
  return consumeStream(response, onEvent);
}

/**
 * Submit locally-executed tool results to resume the paused loop. Returns the
 * next terminal outcome (which may itself be another `tool_use` pause).
 */
export async function submitToolResults(
  store: TokenStore,
  options: SubmitToolResultsOptions,
  onEvent?: (event: GatewayStreamEvent) => void
): Promise<TurnOutcome> {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(options.gatewayBaseUrl);
  const reqOptions: GatewayRequestOptions = { ...options, gatewayBaseUrl };
  const fetchImpl = resolveStreamingFetch(options.fetch);
  const endpoint = gatewayBaseUrl + forgeGatewayRoutes.toolResult(options.sessionId);

  const response = await authedStreamingRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({ results: options.results })
    })
  );
  return consumeStream(response, onEvent);
}

export interface DeleteGatewaySessionOptions extends GatewayRequestOptions {
  sessionId: string;
}

/** Tear down a gateway session. Best-effort: a missing session is not an error. */
export async function deleteGatewaySession(
  store: TokenStore,
  options: DeleteGatewaySessionOptions
): Promise<void> {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(options.gatewayBaseUrl);
  const reqOptions: GatewayRequestOptions = { ...options, gatewayBaseUrl };
  const fetchImpl = resolveStreamingFetch(options.fetch);
  const endpoint = gatewayBaseUrl + forgeGatewayRoutes.session(options.sessionId);

  const response = await authedStreamingRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    })
  );
  // 404 = already gone; treat any 2xx or 404 as success.
  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gateway could not delete the session. Status: ${response.status}.${text ? ` ${text}` : ""}`
    );
  }
}
