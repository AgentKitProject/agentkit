import { describe, expect, test } from "vitest";

import { SseParser } from "../src/gateway/sse.js";
import {
  createGatewaySession,
  streamTurn,
  submitToolResults,
  deleteGatewaySession
} from "../src/gateway/client.js";
import {
  runAgentKitWithGateway,
  type ExecuteTool
} from "../src/gateway/driver.js";
import {
  InsufficientCreditsError,
  normalizeGatewayBaseUrl,
  type StreamingFetchLike,
  type StreamingFetchResponse
} from "../src/gateway/http.js";
import type { StoredSession, TokenStore } from "../src/market/types.js";

// Non-expired unsigned JWT so `ensureAccessToken` never tries to refresh.
function makeJwt(expSecondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })
  ).toString("base64url");
  return `${header}.${payload}.`;
}

const VALID_ACCESS_TOKEN = makeJwt(3600);
const GATEWAY_BASE = "https://forge.agentkitproject.com";

function memoryStore(): TokenStore {
  let session: StoredSession | null = {
    accessToken: VALID_ACCESS_TOKEN,
    refreshToken: "test-refresh",
    connectedAt: new Date().toISOString()
  };
  return {
    async get() {
      return session;
    },
    async set(next) {
      session = next;
    },
    async clear() {
      session = null;
    }
  };
}

/** Build a streaming SSE response, splitting the body into the given chunks. */
function sseResponse(chunks: string[], status = 200): StreamingFetchResponse {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
    async text() {
      return chunks.join("");
    },
    async json() {
      return JSON.parse(chunks.join(""));
    }
  };
}

function jsonResponse(status: number, value: unknown): StreamingFetchResponse {
  const text = JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    body: null,
    async text() {
      return text;
    },
    async json() {
      return value;
    }
  };
}

function dataEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("SseParser", () => {
  test("parses a full event", () => {
    const p = new SseParser();
    const events = p.push(dataEvent({ type: "text", delta: "hi" }));
    expect(events).toEqual([{ type: "text", delta: "hi" }]);
  });

  test("reassembles an event split across chunk boundaries", () => {
    const p = new SseParser();
    const raw = dataEvent({ type: "text", delta: "hello world" });
    // Split mid-JSON.
    const a = raw.slice(0, 15);
    const b = raw.slice(15);
    expect(p.push(a)).toEqual([]);
    expect(p.push(b)).toEqual([{ type: "text", delta: "hello world" }]);
  });

  test("emits multiple events from a single chunk", () => {
    const p = new SseParser();
    const raw =
      dataEvent({ type: "text", delta: "a" }) +
      dataEvent({ type: "text", delta: "b" }) +
      dataEvent({ type: "done", stopReason: "end_turn" });
    const events = p.push(raw);
    expect(events.map((e) => e.type)).toEqual(["text", "text", "done"]);
  });

  test("ignores comments and tolerates CRLF", () => {
    const p = new SseParser();
    const raw = `:keep-alive\r\ndata: ${JSON.stringify({ type: "usage", input_tokens: 5 })}\r\n\r\n`;
    expect(p.push(raw)).toEqual([{ type: "usage", input_tokens: 5 }]);
  });

  test("flush drains a trailing unterminated event", () => {
    const p = new SseParser();
    expect(p.push(`data: ${JSON.stringify({ type: "done", stopReason: "end_turn" })}`)).toEqual([]);
    expect(p.flush()).toEqual([{ type: "done", stopReason: "end_turn" }]);
  });
});

describe("normalizeGatewayBaseUrl", () => {
  test("defaults to hosted forge and strips trailing slash", () => {
    expect(normalizeGatewayBaseUrl()).toBe(GATEWAY_BASE);
    expect(normalizeGatewayBaseUrl("https://self.example.com/")).toBe("https://self.example.com");
  });
  test("rejects non-https", () => {
    expect(() => normalizeGatewayBaseUrl("http://forge.local")).toThrow(/HTTPS/);
  });
});

describe("createGatewaySession", () => {
  test("posts the right body and returns sessionId", async () => {
    let calledUrl = "";
    let sawAuth = "";
    let sentBody: unknown;
    const fetchImpl: StreamingFetchLike = async (input, init) => {
      calledUrl = input;
      sawAuth = init?.headers?.Authorization ?? "";
      sentBody = JSON.parse(init?.body ?? "{}");
      return jsonResponse(200, { sessionId: "sess_123" });
    };
    const sessionId = await createGatewaySession(memoryStore(), {
      fetch: fetchImpl,
      systemPrompt: "You are a kit.",
      tools: [{ name: "read_file", description: "read", input_schema: { type: "object" } }],
      model: "claude-opus-4-8"
    });
    expect(sessionId).toBe("sess_123");
    expect(calledUrl).toBe(`${GATEWAY_BASE}/api/forge/gateway/sessions`);
    expect(sawAuth).toBe(`Bearer ${VALID_ACCESS_TOKEN}`);
    expect(sentBody).toMatchObject({
      systemPrompt: "You are a kit.",
      model: "claude-opus-4-8",
      billing: "managed",
      tools: [{ name: "read_file" }]
    });
  });

  test("throws InsufficientCreditsError on 402", async () => {
    const fetchImpl: StreamingFetchLike = async () =>
      jsonResponse(402, { code: "insufficient_credits", message: "no balance" });
    await expect(
      createGatewaySession(memoryStore(), {
        fetch: fetchImpl,
        systemPrompt: "x",
        tools: [],
        model: "m"
      })
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });
});

describe("streamTurn", () => {
  test("parses text/tool_use/usage/done across chunk boundaries", async () => {
    const full =
      dataEvent({ type: "text", delta: "Let me " }) +
      dataEvent({ type: "text", delta: "look." }) +
      dataEvent({
        type: "tool_use",
        toolUseId: "tu_1",
        name: "read_file",
        input: { path: "/a" }
      }) +
      dataEvent({ type: "usage", output_tokens: 10 }) +
      dataEvent({ type: "done", stopReason: "tool_use" });
    // Split the stream at an awkward boundary (mid-event).
    const cut = 40;
    const fetchImpl: StreamingFetchLike = async () =>
      sseResponse([full.slice(0, cut), full.slice(cut)]);

    const collected: string[] = [];
    const outcome = await streamTurn(
      memoryStore(),
      { fetch: fetchImpl, sessionId: "sess_1", input: "hi" },
      (e) => {
        if (e.type === "text") collected.push((e as { delta: string }).delta);
      }
    );
    expect(collected.join("")).toBe("Let me look.");
    expect(outcome.stopReason).toBe("tool_use");
    expect(outcome.usage).toMatchObject({ output_tokens: 10 });
    expect(outcome.toolUses).toEqual([
      { toolUseId: "tu_1", name: "read_file", input: { path: "/a" } }
    ]);
  });
});

describe("runAgentKitWithGateway", () => {
  test("drives create→turn→tool_use→executeTool→resume→done, accumulating text", async () => {
    const turn1 =
      dataEvent({ type: "text", delta: "Reading file. " }) +
      dataEvent({ type: "tool_use", toolUseId: "tu_1", name: "read_file", input: { path: "/x" } }) +
      dataEvent({ type: "done", stopReason: "tool_use" });
    const turn2 =
      dataEvent({ type: "text", delta: "The file says hello." }) +
      dataEvent({ type: "usage", output_tokens: 3 }) +
      dataEvent({ type: "done", stopReason: "end_turn" });

    const calls: string[] = [];
    let toolResultBody: unknown;
    const fetchImpl: StreamingFetchLike = async (input, init) => {
      calls.push(`${init?.method} ${input}`);
      if (input.endsWith("/sessions")) return jsonResponse(200, { sessionId: "sess_9" });
      if (input.endsWith("/turn")) return sseResponse([turn1]);
      if (input.endsWith("/tool-result")) {
        toolResultBody = JSON.parse(init?.body ?? "{}");
        return sseResponse([turn2]);
      }
      if (init?.method === "DELETE") return jsonResponse(200, {});
      throw new Error(`unexpected ${input}`);
    };

    const seenToolInputs: unknown[] = [];
    const executeTool: ExecuteTool = async (toolUse) => {
      seenToolInputs.push(toolUse.input);
      expect(toolUse.name).toBe("read_file");
      return { result: "hello" };
    };

    const result = await runAgentKitWithGateway(memoryStore(), {
      fetch: fetchImpl,
      systemPrompt: "You read files.",
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
      model: "claude-opus-4-8",
      input: "read /x",
      executeTool
    });

    expect(seenToolInputs).toEqual([{ path: "/x" }]);
    expect(toolResultBody).toEqual({
      results: [{ toolUseId: "tu_1", result: "hello" }]
    });
    expect(result.text).toBe("Reading file. The file says hello.");
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolRounds).toBe(1);
    expect(result.usage).toMatchObject({ output_tokens: 3 });
    // Session is torn down at the end.
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
  });

  test("surfaces InsufficientCreditsError thrown at session create", async () => {
    const fetchImpl: StreamingFetchLike = async (input) => {
      if (input.endsWith("/sessions"))
        return jsonResponse(402, { code: "insufficient_credits" });
      throw new Error("should not reach turn");
    };
    let executeCalled = false;
    await expect(
      runAgentKitWithGateway(memoryStore(), {
        fetch: fetchImpl,
        systemPrompt: "x",
        tools: [],
        model: "m",
        input: "go",
        executeTool: async () => {
          executeCalled = true;
          return { result: "x" };
        }
      })
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(executeCalled).toBe(false);
  });

  test("surfaces InsufficientCreditsError thrown mid-loop at turn", async () => {
    const fetchImpl: StreamingFetchLike = async (input) => {
      if (input.endsWith("/sessions")) return jsonResponse(200, { sessionId: "s" });
      if (input.endsWith("/turn")) return jsonResponse(402, { code: "insufficient_credits" });
      return jsonResponse(200, {});
    };
    await expect(
      runAgentKitWithGateway(memoryStore(), {
        fetch: fetchImpl,
        systemPrompt: "x",
        tools: [],
        model: "m",
        input: "go",
        executeTool: async () => ({ result: "x" })
      })
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  test("executeTool throwing becomes an error tool-result, loop continues", async () => {
    const turn1 =
      dataEvent({ type: "tool_use", toolUseId: "tu_e", name: "boom", input: {} }) +
      dataEvent({ type: "done", stopReason: "tool_use" });
    const turn2 = dataEvent({ type: "done", stopReason: "end_turn" });
    let resultBody: { results?: Array<{ error?: string }> } | undefined;
    const fetchImpl: StreamingFetchLike = async (input, init) => {
      if (input.endsWith("/sessions")) return jsonResponse(200, { sessionId: "s" });
      if (input.endsWith("/turn")) return sseResponse([turn1]);
      if (input.endsWith("/tool-result")) {
        resultBody = JSON.parse(init?.body ?? "{}");
        return sseResponse([turn2]);
      }
      return jsonResponse(200, {});
    };
    const result = await runAgentKitWithGateway(memoryStore(), {
      fetch: fetchImpl,
      systemPrompt: "x",
      tools: [],
      model: "m",
      input: "go",
      executeTool: async () => {
        throw new Error("tool exploded");
      }
    });
    expect(resultBody?.results?.[0]?.error).toBe("tool exploded");
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("deleteGatewaySession", () => {
  test("treats 404 as success", async () => {
    const fetchImpl: StreamingFetchLike = async () => jsonResponse(404, {});
    await expect(
      deleteGatewaySession(memoryStore(), { fetch: fetchImpl, sessionId: "gone" })
    ).resolves.toBeUndefined();
  });

  test("posts DELETE with bearer", async () => {
    let method = "";
    let auth = "";
    const fetchImpl: StreamingFetchLike = async (_input, init) => {
      method = init?.method ?? "";
      auth = init?.headers?.Authorization ?? "";
      return jsonResponse(200, {});
    };
    await deleteGatewaySession(memoryStore(), { fetch: fetchImpl, sessionId: "s1" });
    expect(method).toBe("DELETE");
    expect(auth).toBe(`Bearer ${VALID_ACCESS_TOKEN}`);
  });
});
