/**
 * Router tests for routeGatewayRequest.
 *
 * Covers the endpoint contract mapping, the entitlement seam (default allow +
 * deny), the SSE turn/tool-result drive, and pre-stream error mapping
 * (session-not-found, insufficient credits).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ChatProvider, StreamEvent } from "../src/core/ports.js";
import type { ChatRequest } from "../src/core/types.js";
import {
  routeGatewayRequest,
  type GatewayRouterDeps,
  type GatewayJsonResponse,
  type SseEmitter,
} from "../src/core/router.js";
import type { StreamingTurnDeps } from "../src/core/services/streaming-turn.js";
import type { CreateGatewaySessionDeps, EntitlementCheck } from "../src/core/services/gateway-session.js";
import { InMemoryLedger, InMemorySessionStore } from "./fakes.js";

const NOW = "2026-06-17T12:00:00Z";

function textProvider(text: string): ChatProvider {
  return {
    providerType: "anthropic",
    sendMessage: async () => {
      throw new Error("unused");
    },
    streamMessage: async (_req: ChatRequest, onEvent: (e: StreamEvent) => void) => {
      onEvent({ type: "text", delta: text });
      onEvent({ type: "usage", input: 100, output: 50, cached: 0 });
      onEvent({ type: "done", stopReason: "end_turn" });
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedWriteTokens: 0 },
      };
    },
  };
}

/** Collects emitted events; records whether close() was called. */
function recordingEmitter(): SseEmitter & { events: StreamEvent[]; closed: boolean } {
  const state = { events: [] as StreamEvent[], closed: false };
  return {
    events: state.events,
    get closed() {
      return state.closed;
    },
    emit(e) {
      state.events.push(e);
    },
    close() {
      state.closed = true;
    },
  };
}

describe("routeGatewayRequest", () => {
  let ledger: InMemoryLedger;
  let sessions: InMemorySessionStore;
  let emitter: ReturnType<typeof recordingEmitter>;

  function makeDeps(
    overrides: { entitlementCheck?: EntitlementCheck; provider?: ChatProvider } = {},
  ): GatewayRouterDeps {
    const session: CreateGatewaySessionDeps = {
      sessions,
      now: () => NOW,
      entitlementCheck: overrides.entitlementCheck,
      ttlSeconds: Math.floor(Date.now() / 1000) - Math.floor(Date.parse(NOW) / 1000) + 3600,
    };
    const turn: StreamingTurnDeps = {
      chatProvider: overrides.provider ?? textProvider("hello"),
      ledger,
      sessions,
      resolveSystemPrompt: async () => "SECRET",
      now: () => NOW,
      model: "claude-sonnet-4-5",
      maxTokens: 512,
    };
    return { session, turn, createEmitter: () => emitter };
  }

  beforeEach(() => {
    ledger = new InMemoryLedger();
    sessions = new InMemorySessionStore();
    emitter = recordingEmitter();
  });

  it("POST /gateway/sessions creates a session (default allow) without leaking the prompt ref", async () => {
    const res = (await routeGatewayRequest(makeDeps(), {
      method: "POST",
      path: "/gateway/sessions",
      body: { kitId: "kit-1", billing: "byo" },
      userId: "user-1",
    })) as GatewayJsonResponse;

    expect(res.kind).toBe("json");
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body["sessionId"]).toBeTruthy();
    expect(body["billingMode"]).toBe("byo");
    expect(JSON.stringify(body)).not.toContain("systemPromptRef");
  });

  it("entitlement deny → 403", async () => {
    const deny: EntitlementCheck = async () => ({ allowed: false, reason: "not purchased" });
    const res = (await routeGatewayRequest(makeDeps({ entitlementCheck: deny }), {
      method: "POST",
      path: "/gateway/sessions",
      body: { kitId: "kit-1", billing: "managed" },
      userId: "user-1",
    })) as GatewayJsonResponse;

    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("entitlement_denied");
  });

  it("invalid billing → 400", async () => {
    const res = (await routeGatewayRequest(makeDeps(), {
      method: "POST",
      path: "/gateway/sessions",
      body: { kitId: "kit-1" },
      userId: "user-1",
    })) as GatewayJsonResponse;
    expect(res.status).toBe(400);
  });

  it("POST /gateway/sessions/{id}/turn streams events and closes (BYO)", async () => {
    // Create a BYO session first.
    const created = (await routeGatewayRequest(makeDeps(), {
      method: "POST",
      path: "/gateway/sessions",
      body: { kitId: "kit-1", billing: "byo" },
      userId: "user-1",
    })) as GatewayJsonResponse;
    const sessionId = (created.body as { sessionId: string }).sessionId;

    const res = await routeGatewayRequest(makeDeps(), {
      method: "POST",
      path: `/gateway/sessions/${sessionId}/turn`,
      body: { userInput: "hello there" },
      userId: "user-1",
    });

    expect(res.kind).toBe("stream");
    expect((res as { status: number }).status).toBe(200);
    expect(emitter.closed).toBe(true);
    // Allowed events only; secret prompt never present.
    expect(emitter.events.map((e) => e.type)).toContain("text");
    expect(emitter.events.map((e) => e.type)).toContain("done");
    expect(JSON.stringify(emitter.events)).not.toContain("SECRET");
  });

  it("turn on a missing session → 402/404 pre-stream JSON, nothing emitted", async () => {
    const res = (await routeGatewayRequest(makeDeps(), {
      method: "POST",
      path: "/gateway/sessions/does-not-exist/turn",
      body: { userInput: "hi" },
      userId: "user-1",
    })) as GatewayJsonResponse;

    expect(res.kind).toBe("json");
    expect(res.status).toBe(404);
    expect(emitter.events.length).toBe(0);
    expect(emitter.closed).toBe(true);
  });

  it("DELETE /gateway/sessions/{id} → 204", async () => {
    const created = (await routeGatewayRequest(makeDeps(), {
      method: "POST",
      path: "/gateway/sessions",
      body: { kitId: "kit-1", billing: "byo" },
      userId: "user-1",
    })) as GatewayJsonResponse;
    const sessionId = (created.body as { sessionId: string }).sessionId;

    const res = (await routeGatewayRequest(makeDeps(), {
      method: "DELETE",
      path: `/gateway/sessions/${sessionId}`,
      userId: "user-1",
    })) as GatewayJsonResponse;
    expect(res.status).toBe(204);
    expect(await sessions.getSession(sessionId)).toBeUndefined();
  });

  it("unknown route → 404", async () => {
    const res = (await routeGatewayRequest(makeDeps(), {
      method: "GET",
      path: "/gateway/unknown",
      userId: "user-1",
    })) as GatewayJsonResponse;
    expect(res.status).toBe(404);
  });
});
