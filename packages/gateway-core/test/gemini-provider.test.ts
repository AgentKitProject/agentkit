/**
 * Unit tests for GeminiChatProvider (sendMessage + streamMessage).
 *
 * Mocks global fetch. Covers:
 *   - sendMessage text
 *   - tool_use round-trip: a request with tools + a prior tool_result maps to
 *     functionDeclarations + a functionResponse part (schema sanitized; role
 *     "model" for the assistant tool_use, "user" for the tool_result); the
 *     response functionCall parses to a normalized tool_use block.
 *   - streaming text deltas
 *   - streaming functionCall accumulation (partial + complete + tool_use stop)
 *   - usage mapping (usageMetadata → TokenUsage)
 *   - an error case (non-2xx → GeminiProviderError, error StreamEvent)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { GeminiChatProvider, GeminiProviderError } from "../src/adapters/gemini/index.js";
import type { StreamEvent } from "../src/core/ports.js";
import type { ChatRequest } from "../src/core/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds a JSON Response. */
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds an SSE Response with a ReadableStream body chunked at small offsets. */
function sseResponse(text: string, chunkSize = 19): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// sendMessage — text
// ---------------------------------------------------------------------------

describe("GeminiChatProvider.sendMessage — text", () => {
  it("maps system → systemInstruction, messages → contents, and parses text + usage", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hello, " }, { text: "world." }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 7 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiChatProvider({ apiKey: "secret-key" });
    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      system: "SECRET KIT PROMPT — never leak",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 256,
    };

    const res = await provider.sendMessage(request);

    expect(res.content).toEqual([{ type: "text", text: "Hello, world." }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({
      inputTokens: 31,
      outputTokens: 7,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });

    // URL hits :generateContent (no key in the URL), key is in the header.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(url).not.toContain("secret-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");

    const body = JSON.parse(init.body as string) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: unknown[] }[];
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.systemInstruction.parts[0].text).toContain("SECRET KIT PROMPT");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// tool_use round-trip (request mapping + response functionCall parse)
// ---------------------------------------------------------------------------

describe("GeminiChatProvider.sendMessage — tool_use round-trip", () => {
  it("maps tools→functionDeclarations, tool_use→functionCall(model), tool_result→functionResponse(user); parses response functionCall", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }],
            },
            finishReason: "STOP", // Gemini reports STOP even with a functionCall
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiChatProvider({ apiKey: "k" });
    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      system: "sys",
      messages: [
        { role: "user", content: [{ type: "text", text: "weather in Paris?" }] },
        // a prior assistant tool_use → functionCall in a "model" content
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "gemini-lookup-0", name: "lookup", input: { q: "x" } }],
        },
        // a prior tool_result → functionResponse in a "user" content
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "gemini-lookup-0", content: "sunny" }],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            additionalProperties: false,
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      maxTokens: 512,
    };

    const res = await provider.sendMessage(request);

    // --- response functionCall → normalized tool_use block ---
    expect(res.content).toEqual([
      { type: "tool_use", id: "gemini-get_weather-0", name: "get_weather", input: { city: "Paris" } },
    ]);
    // finishReason STOP + a functionCall present → tool_use stop reason
    expect(res.stopReason).toBe("tool_use");

    // --- request mapping ---
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      contents: { role: string; parts: any[] }[];
      tools: { functionDeclarations: any[] }[];
    };

    // tools → functionDeclarations with sanitized schema ($schema + additionalProperties stripped)
    expect(body.tools).toHaveLength(1);
    const decl = body.tools[0].functionDeclarations[0];
    expect(decl.name).toBe("get_weather");
    expect(decl.description).toBe("Get weather");
    expect(decl.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
    expect(decl.parameters.$schema).toBeUndefined();
    expect(decl.parameters.additionalProperties).toBeUndefined();

    // assistant tool_use → functionCall in a model-role content
    const modelContent = body.contents.find((c) => c.role === "model")!;
    expect(modelContent.parts[0]).toEqual({ functionCall: { name: "lookup", args: { q: "x" } } });

    // tool_result → functionResponse in a user-role content; name recovered from synthetic id
    const fnRespContent = body.contents.find((c) =>
      c.parts.some((p: any) => p.functionResponse),
    )!;
    expect(fnRespContent.role).toBe("user");
    expect(fnRespContent.parts[0]).toEqual({
      functionResponse: { name: "lookup", response: { content: "sunny" } },
    });
  });
});

// ---------------------------------------------------------------------------
// streamMessage — text + functionCall accumulation + usage
// ---------------------------------------------------------------------------

const STREAM_FIXTURE = [
  `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Let me "}]}}],"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":0}}`,
  ``,
  `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"check the weather."}]}}]}`,
  ``,
  `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":42}}`,
  ``,
].join("\n");

describe("GeminiChatProvider.streamMessage — SSE parsing", () => {
  it("parses text deltas, functionCall accumulation (partial+complete), usage, done", async () => {
    const fetchMock = vi.fn(async () => sseResponse(STREAM_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiChatProvider({ apiKey: "test-key" });
    const events: StreamEvent[] = [];

    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      system: "SECRET KIT PROMPT — must never be emitted",
      messages: [{ role: "user", content: [{ type: "text", text: "weather in Paris?" }] }],
      tools: [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object" } }],
      maxTokens: 1024,
    };

    const response = await provider.streamMessage(request, (ev) => events.push(ev));

    // --- text deltas ---
    const textDeltas = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta);
    expect(textDeltas.join("")).toBe("Let me check the weather.");

    // --- tool_use: a partial fragment (stringified args) + a complete parsed input ---
    const toolEvents = events.filter((e) => e.type === "tool_use") as Array<
      Extract<StreamEvent, { type: "tool_use" }>
    >;
    const partial = toolEvents.find((e) => e.inputPartial !== undefined);
    const complete = toolEvents.find((e) => e.inputComplete !== undefined);
    expect(partial?.inputPartial).toBe('{"city":"Paris"}');
    expect(complete?.toolUseId).toBe("gemini-get_weather-0");
    expect(complete?.name).toBe("get_weather");
    expect(complete?.inputComplete).toEqual({ city: "Paris" });

    // --- usage (cumulative; latest wins) ---
    const usageEvents = events.filter((e) => e.type === "usage") as Array<
      Extract<StreamEvent, { type: "usage" }>
    >;
    const lastUsage = usageEvents[usageEvents.length - 1];
    expect(lastUsage.input).toBe(1200);
    expect(lastUsage.output).toBe(42);

    // --- terminal done with tool_use stop reason ---
    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done?.stopReason).toBe("tool_use");
    expect(events.some((e) => e.type === "error")).toBe(false);

    // --- assembled ChatResponse ---
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "gemini-get_weather-0", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });

    // --- request used :streamGenerateContent?alt=sse with the system prompt on the wire only ---
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(":streamGenerateContent?alt=sse");
    expect(url).not.toContain("test-key");
    const sentBody = JSON.parse(init.body as string) as { systemInstruction?: { parts: { text: string }[] } };
    expect(sentBody.systemInstruction?.parts[0].text).toContain("SECRET KIT PROMPT");
  });

  it("emits an error event and throws GeminiProviderError on a non-2xx response", async () => {
    const errorBody = JSON.stringify({ error: { message: "quota exceeded" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(errorBody, { status: 429 })),
    );

    const provider = new GeminiChatProvider({ apiKey: "test-key" });
    const events: StreamEvent[] = [];

    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 64,
    };

    await expect(
      provider.streamMessage(request, (ev) => events.push(ev)),
    ).rejects.toBeInstanceOf(GeminiProviderError);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — error case
// ---------------------------------------------------------------------------

describe("GeminiChatProvider.sendMessage — errors", () => {
  it("throws GeminiProviderError on a non-2xx response", async () => {
    const errorBody = JSON.stringify({ error: { message: "invalid argument" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(errorBody, { status: 400 })),
    );

    const provider = new GeminiChatProvider({ apiKey: "k" });
    const request: ChatRequest = {
      model: "gemini-2.0-flash",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 64,
    };

    await expect(provider.sendMessage(request)).rejects.toThrow(/invalid argument/);
  });
});
