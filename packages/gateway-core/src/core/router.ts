/**
 * Framework-agnostic gateway router.
 *
 * A host (Next.js route, Lambda, node:http server) adapts its request/response
 * to `routeGatewayRequest`, which maps the tier3-gateway endpoint contract:
 *
 *   POST   /gateway/sessions                      → create a session (entitlement-checked)
 *   POST   /gateway/sessions/{id}/turn            → run a turn (SSE)
 *   POST   /gateway/sessions/{id}/tool-result     → resume with tool results (SSE)
 *   DELETE /gateway/sessions/{id}                 → end the session
 *
 * The router is transport-agnostic: SSE responses are delivered through a
 * `SseEmitter` the host provides (it knows how to write chunks to its own
 * response object). The router NEVER writes the injected system prompt or the
 * full history to the emitter — only normalized StreamEvents flow through it.
 *
 * The router does no auth itself: the host authenticates the caller (WorkOS
 * bearer for desktop/CLI, cookie→bearer for web — the existing dual-path) and
 * passes the resolved `userId` in on every request.
 */

import type { StreamEvent } from "./ports.js";
import type { BillingMode, ByoProviderConfig } from "./types.js";
import {
  createGatewaySession,
  deleteGatewaySession,
  EntitlementDeniedError,
  type CreateGatewaySessionDeps,
  type CreateGatewaySessionRequest,
} from "./services/gateway-session.js";
import {
  runStreamingTurn,
  resumeWithToolResults,
  SessionNotFoundError,
  InvalidTurnStateError,
  type StreamingTurnDeps,
  type ToolResultInput,
} from "./services/streaming-turn.js";
import { InsufficientCreditsError } from "./services/managed-turn.js";

// ---------------------------------------------------------------------------
// Transport-agnostic request / response shapes
// ---------------------------------------------------------------------------

/** A normalized inbound request the host adapts from its native request. */
export interface GatewayRequest {
  method: "POST" | "DELETE" | string;
  /** Path beginning with /gateway/... (query string stripped). */
  path: string;
  /** Parsed JSON body (may be undefined for DELETE). */
  body?: unknown;
  /**
   * The authenticated caller's user id. The host resolves this from the bearer
   * token / cookie session BEFORE calling the router.
   */
  userId: string;
}

/**
 * The host-provided SSE channel for streaming routes. The router pushes
 * normalized events; the host serializes them as Server-Sent Events (or any
 * streaming transport) on its own response object. `close` ends the stream.
 */
export interface SseEmitter {
  emit(event: StreamEvent): void;
  close(): void;
}

/** A non-streaming JSON response (create / delete / errors). */
export interface GatewayJsonResponse {
  kind: "json";
  status: number;
  body: unknown;
}

/**
 * A streaming response. The router has driven the SSE emitter to completion by
 * the time it resolves; `status` is the HTTP status the host should have used
 * for the stream (200 on success). For pre-stream failures (e.g. session not
 * found, insufficient credits surfaced before any event) the router returns a
 * `json` response instead so the host can set a non-200 status.
 */
export interface GatewayStreamResponse {
  kind: "stream";
  status: number;
}

export type GatewayResponse = GatewayJsonResponse | GatewayStreamResponse;

// ---------------------------------------------------------------------------
// Router deps
// ---------------------------------------------------------------------------

export interface GatewayRouterDeps {
  session: CreateGatewaySessionDeps;
  turn: StreamingTurnDeps;
  /**
   * Factory the host supplies to obtain an SseEmitter for a streaming route.
   * Called only for /turn and /tool-result. Returning the emitter lets the host
   * set SSE headers and begin the response body before events flow.
   */
  createEmitter: () => SseEmitter;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SESSION_RE = /^\/gateway\/sessions\/([^/]+)(\/turn|\/tool-result)?$/;

export async function routeGatewayRequest(
  deps: GatewayRouterDeps,
  req: GatewayRequest,
): Promise<GatewayResponse> {
  const path = req.path.split("?")[0]!.replace(/\/+$/, "") || "/";

  // POST /gateway/sessions
  if (path === "/gateway/sessions" && req.method === "POST") {
    return handleCreateSession(deps, req);
  }

  const match = SESSION_RE.exec(path);
  if (match) {
    const sessionId = match[1]!;
    const sub = match[2];

    if (sub === "/turn" && req.method === "POST") {
      return handleTurn(deps, req, sessionId);
    }
    if (sub === "/tool-result" && req.method === "POST") {
      return handleToolResult(deps, req, sessionId);
    }
    if (!sub && req.method === "DELETE") {
      return handleDeleteSession(deps, sessionId);
    }
  }

  return json(404, { error: "not_found", message: `No route for ${req.method} ${path}` });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateSession(
  deps: GatewayRouterDeps,
  req: GatewayRequest,
): Promise<GatewayResponse> {
  const body = (req.body ?? {}) as {
    kitId?: string;
    kitSlug?: string;
    billing?: BillingMode;
    systemPromptRef?: string;
    byoProviderConfig?: ByoProviderConfig | null;
  };

  if (body.billing !== "managed" && body.billing !== "byo") {
    return json(400, {
      error: "invalid_request",
      message: 'Field "billing" must be "managed" or "byo".',
    });
  }

  const request: CreateGatewaySessionRequest = {
    userId: req.userId,
    kitId: body.kitId,
    kitSlug: body.kitSlug,
    billing: body.billing,
    systemPromptRef: body.systemPromptRef,
    byoProviderConfig: body.byoProviderConfig ?? null,
  };

  try {
    const session = await createGatewaySession(deps.session, request);
    // NEVER return systemPromptRef content; only the opaque session handle.
    return json(201, {
      sessionId: session.sessionId,
      kitId: session.kitId,
      billingMode: session.billingMode,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    if (err instanceof EntitlementDeniedError) {
      return json(403, { error: "entitlement_denied", message: err.message });
    }
    throw err;
  }
}

async function handleTurn(
  deps: GatewayRouterDeps,
  req: GatewayRequest,
  sessionId: string,
): Promise<GatewayResponse> {
  const body = (req.body ?? {}) as { userInput?: string };
  if (typeof body.userInput !== "string") {
    return json(400, {
      error: "invalid_request",
      message: 'Field "userInput" (string) is required.',
    });
  }

  return driveStream(deps, (emitter) =>
    runStreamingTurn(deps.turn, sessionId, { userInput: body.userInput! }, (ev) =>
      emitter.emit(ev),
    ),
  );
}

async function handleToolResult(
  deps: GatewayRouterDeps,
  req: GatewayRequest,
  sessionId: string,
): Promise<GatewayResponse> {
  const body = (req.body ?? {}) as { results?: unknown };
  const results = normalizeToolResults(body.results);
  if (!results) {
    return json(400, {
      error: "invalid_request",
      message:
        'Field "results" must be an array of { toolUseId, result | error }.',
    });
  }

  return driveStream(deps, (emitter) =>
    resumeWithToolResults(deps.turn, sessionId, results, (ev) => emitter.emit(ev)),
  );
}

async function handleDeleteSession(
  deps: GatewayRouterDeps,
  sessionId: string,
): Promise<GatewayResponse> {
  await deleteGatewaySession(deps.session, sessionId);
  return json(204, null);
}

// ---------------------------------------------------------------------------
// Stream driving + error mapping
// ---------------------------------------------------------------------------

/**
 * Drives a streaming service call through a host emitter. Pre-stream failures
 * (session-not-found, invalid-turn-state, insufficient-credits) are mapped to
 * JSON error responses; in-stream provider errors have already surfaced as an
 * `error` StreamEvent (emitted by the provider adapter), so we close the stream
 * cleanly and report status 200 for the (already-started) stream.
 */
async function driveStream(
  deps: GatewayRouterDeps,
  run: (emitter: SseEmitter) => Promise<unknown>,
): Promise<GatewayResponse> {
  const emitter = deps.createEmitter();
  let started = false;
  const trackingEmitter: SseEmitter = {
    emit(ev) {
      started = true;
      emitter.emit(ev);
    },
    close() {
      emitter.close();
    },
  };

  try {
    await run(trackingEmitter);
    trackingEmitter.close();
    return { kind: "stream", status: 200 };
  } catch (err) {
    // If nothing has been emitted yet, we can still return a clean JSON error
    // (the host hasn't committed to a 200 SSE response). Otherwise the error
    // has already crossed as an `error` event; just close.
    if (!started) {
      const mapped = mapPreStreamError(err);
      if (mapped) {
        emitter.close();
        return mapped;
      }
    }
    // Surface an error event if the provider didn't already, then close.
    trackingEmitter.emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    emitter.close();
    return { kind: "stream", status: 200 };
  }
}

function mapPreStreamError(err: unknown): GatewayJsonResponse | undefined {
  if (err instanceof SessionNotFoundError) {
    return json(404, { error: "session_not_found", message: err.message });
  }
  if (err instanceof InvalidTurnStateError) {
    return json(409, { error: "invalid_turn_state", message: err.message });
  }
  if (err instanceof InsufficientCreditsError) {
    return json(402, {
      error: "insufficient_credits",
      message: err.message,
      requiredCents: err.requiredCents,
      availableCents: err.availableCents,
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): GatewayJsonResponse {
  return { kind: "json", status, body };
}

/** Validates + normalizes the tool-result array; returns undefined if invalid. */
function normalizeToolResults(raw: unknown): ToolResultInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ToolResultInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined;
    const r = item as Record<string, unknown>;
    if (typeof r["toolUseId"] !== "string") return undefined;
    const entry: ToolResultInput = { toolUseId: r["toolUseId"] };
    if (typeof r["error"] === "string") {
      entry.error = r["error"];
    } else if (typeof r["result"] === "string") {
      entry.result = r["result"];
    } else if (Array.isArray(r["result"])) {
      // Accept [{ type: "text", text }] blocks.
      const blocks = (r["result"] as unknown[]).filter(
        (b): b is { type: "text"; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      );
      entry.result = blocks;
    } else {
      // Neither result nor error → empty success result.
      entry.result = "";
    }
    out.push(entry);
  }
  return out;
}
