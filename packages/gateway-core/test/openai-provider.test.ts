/**
 * Unit tests for OpenAIChatProvider (+ the openai-compatible variant).
 *
 * Mocks global `fetch` (mirroring anthropic-stream.test.ts). Covers:
 *   - sendMessage: plain text response
 *   - sendMessage: tool_use round-trip — the request maps `tools` + a PRIOR
 *     assistant tool_use and a tool_result into OpenAI wire shape, and the
 *     response's `tool_calls` parse into normalized tool_use blocks
 *   - streamMessage: text deltas + tool-call argument accumulation + usage + done
 *   - streamMessage: error event + throw on non-2xx
 *   - the openai-compatible variant reuses the same mapping with a custom baseUrl
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  OpenAIChatProvider,
  OpenAICompatibleChatProvider,
} from "../src/adapters/openai/index.js";
import type { StreamEvent } from "../src/core/ports.js";
import type { ChatRequest } from "../src/core/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a Response with a ReadableStream body, chunked at arbitrary offsets. */
function sseResponse(text: string, chunkSize = 17): Response {
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

function textRequest(): ChatRequest {
  return {
    model: "gpt-4o",
    system: "SECRET KIT PROMPT — must never be emitted to the client",
    messages: [{ role: "user", content: [{ type: "text", text: "weather in Paris?" }] }],
    tools: [],
    maxTokens: 1024,
  };
}

// ---------------------------------------------------------------------------
// sendMessage — text
// ---------------------------------------------------------------------------

describe("OpenAIChatProvider.sendMessage — text", () => {
  it("maps a plain text completion + usage and sends the system prompt", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          { message: { role: "assistant", content: "Sunny and 21°C." }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 7 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIChatProvider({ apiKey: "test-key" });
    const response = await provider.sendMessage(textRequest());

    expect(response.content).toEqual([{ type: "text", text: "Sunny and 21°C." }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 7,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });

    // URL + auth header + system message on the wire.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const sent = JSON.parse(init.body as string) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
    };
    expect(sent.model).toBe("gpt-4o");
    expect(sent.max_tokens).toBe(1024);
    expect(sent.messages[0]).toEqual({
      role: "system",
      content: "SECRET KIT PROMPT — must never be emitted to the client",
    });
    expect(sent.messages[1]).toEqual({ role: "user", content: "weather in Paris?" });
    expect(sent.tools).toBeUndefined();
  });

  it("throws OpenAIProviderError with parsed message on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "rate limit exceeded" } }, 429),
      ),
    );
    const provider = new OpenAIChatProvider({ apiKey: "test-key" });
    await expect(provider.sendMessage(textRequest())).rejects.toThrow(
      /OpenAI request failed \(429\): rate limit exceeded/,
    );
  });
});

// ---------------------------------------------------------------------------
// sendMessage — tool_use round-trip
// ---------------------------------------------------------------------------

describe("OpenAIChatProvider.sendMessage — tool_use round-trip", () => {
  it("maps tools + a prior tool_use/tool_result into OpenAI wire shape and parses tool_calls back", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 12 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIChatProvider({ apiKey: "test-key" });

    // A history that already contains an assistant tool_use and the user's
    // tool_result for it — exercises BOTH directions of the mapping.
    const request: ChatRequest = {
      model: "gpt-4o",
      system: "kit prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "weather in Paris?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_prev", name: "get_weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_prev", content: "rainy, 14°C" },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      maxTokens: 512,
    };

    const response = await provider.sendMessage(request);

    // --- request mapping ---
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        tool_call_id?: string;
      }>;
      tools: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>;
    };

    // tools → OpenAI function tool shape
    expect(sent.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);

    // [system, user, assistant(tool_calls), tool(result)]
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[1]).toEqual({ role: "user", content: "weather in Paris?" });

    const assistantMsg = sent.messages[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("Let me check.");
    expect(assistantMsg.tool_calls).toEqual([
      {
        id: "call_prev",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);

    const toolMsg = sent.messages[3];
    expect(toolMsg).toEqual({
      role: "tool",
      tool_call_id: "call_prev",
      content: "rainy, 14°C",
    });

    // --- response mapping: tool_calls → normalized tool_use ---
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(response.usage.inputTokens).toBe(50);
    expect(response.usage.outputTokens).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// streamMessage — text + tool-call argument accumulation
// ---------------------------------------------------------------------------

const STREAM_FIXTURE = [
  // text deltas
  `data: {"choices":[{"delta":{"role":"assistant","content":"Let me "},"finish_reason":null}]}`,
  ``,
  `data: {"choices":[{"delta":{"content":"check the weather."},"finish_reason":null}]}`,
  ``,
  // tool_call: id + name on first fragment, arguments streamed in two fragments
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": "}}]},"finish_reason":null}]}`,
  ``,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":null}]}`,
  ``,
  // finish + usage-only final chunk
  `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
  ``,
  `data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":42,"prompt_tokens_details":{"cached_tokens":200}}}`,
  ``,
  `data: [DONE]`,
  ``,
].join("\n");

describe("OpenAIChatProvider.streamMessage — SSE parsing", () => {
  it("parses text deltas, tool_call argument accumulation, usage, and done", async () => {
    const fetchMock = vi.fn(async () => sseResponse(STREAM_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIChatProvider({ apiKey: "test-key" });
    const events: StreamEvent[] = [];
    const response = await provider.streamMessage(
      {
        model: "gpt-4o",
        system: "SECRET KIT PROMPT",
        messages: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object" } }],
        maxTokens: 1024,
      },
      (ev) => events.push(ev),
    );

    // text deltas
    const textDeltas = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta);
    expect(textDeltas.join("")).toBe("Let me check the weather.");

    // tool_use: partial fragments then a complete parsed input
    const toolEvents = events.filter((e) => e.type === "tool_use") as Array<
      Extract<StreamEvent, { type: "tool_use" }>
    >;
    const partials = toolEvents.filter((e) => e.inputPartial !== undefined);
    const complete = toolEvents.find((e) => e.inputComplete !== undefined);
    expect(partials.length).toBe(2);
    expect(partials.map((p) => p.inputPartial).join("")).toBe('{"city": "Paris"}');
    expect(complete?.toolUseId).toBe("call_9");
    expect(complete?.name).toBe("get_weather");
    expect(complete?.inputComplete).toEqual({ city: "Paris" });

    // usage event
    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }>;
    expect(usage).toBeDefined();
    expect(usage.input).toBe(1200);
    expect(usage.output).toBe(42);
    expect(usage.cached).toBe(200);

    // terminal done
    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done?.stopReason).toBe("tool_use");

    expect(events.some((e) => e.type === "error")).toBe(false);

    // assembled ChatResponse
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cachedReadTokens: 200,
      cachedWriteTokens: 0,
    });

    // request used stream:true + include_usage and carried the system prompt
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
      messages: Array<{ role: string; content: string }>;
    };
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options?.include_usage).toBe(true);
    expect(sentBody.messages[0]).toEqual({ role: "system", content: "SECRET KIT PROMPT" });
  });

  it("emits an error event and throws on a non-2xx response", async () => {
    const errorBody = JSON.stringify({ error: { message: "overloaded" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(errorBody, { status: 503 })));

    const provider = new OpenAIChatProvider({ apiKey: "test-key" });
    const events: StreamEvent[] = [];
    await expect(
      provider.streamMessage(textRequest(), (ev) => events.push(ev)),
    ).rejects.toThrow(/overloaded/);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// openai-compatible variant
// ---------------------------------------------------------------------------

describe("OpenAICompatibleChatProvider", () => {
  it("reuses the OpenAI mapping with a required custom baseUrl and providerType", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleChatProvider({
      apiKey: "k",
      baseUrl: "https://llm.internal/v1/",
      model: "local-model",
    });
    expect(provider.providerType).toBe("openai-compatible");

    const response = await provider.sendMessage({
      model: "",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      maxTokens: 64,
    });
    expect(response.content).toEqual([{ type: "text", text: "hi" }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // trailing slash stripped + path appended
    expect(url).toBe("https://llm.internal/v1/chat/completions");
    // falls back to the constructor model when the request omits one
    const sent = JSON.parse(init.body as string) as { model: string };
    expect(sent.model).toBe("local-model");
  });

  it("requires an explicit baseUrl", () => {
    expect(
      () => new OpenAICompatibleChatProvider({ apiKey: "k", baseUrl: "" }),
    ).toThrow(/requires an explicit baseUrl/);
  });
});
