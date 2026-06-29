/**
 * Unit tests for OllamaChatProvider (native /api/chat adapter).
 *
 * Mocks global fetch to return either a JSON body (non-streaming sendMessage)
 * or an NDJSON ReadableStream (streamMessage). Asserts the adapter maps to/from
 * the SAME normalized shapes as the Anthropic reference adapter, that the
 * tool_use / tool_result mapping is faithful in both directions, and that
 * Ollama's NDJSON streaming is parsed correctly.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { OllamaChatProvider, OllamaProviderError } from "../src/adapters/ollama/index.js";
import type { StreamEvent } from "../src/core/ports.js";
import type { ChatRequest } from "../src/core/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A Response whose body is a JSON document (non-streaming /api/chat). */
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A Response whose body is an NDJSON ReadableStream, chunked across line boundaries. */
function ndjsonResponse(text: string, chunkSize = 13): Response {
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
    headers: { "content-type": "application/x-ndjson" },
  });
}

function makeRequest(): ChatRequest {
  return {
    model: "llama3.1",
    system: "SECRET KIT PROMPT — must never be emitted to the client",
    messages: [{ role: "user", content: [{ type: "text", text: "weather in Paris?" }] }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    maxTokens: 1024,
  };
}

// ---------------------------------------------------------------------------
// sendMessage — plain text
// ---------------------------------------------------------------------------

describe("OllamaChatProvider.sendMessage", () => {
  it("maps a plain text response, usage, stop reason, and request body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: "llama3.1",
        message: { role: "assistant", content: "Hello there!" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 25,
        eval_count: 7,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OllamaChatProvider();
    const response = await provider.sendMessage(makeRequest());

    expect(response.content).toEqual([{ type: "text", text: "Hello there!" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({
      inputTokens: 25,
      outputTokens: 7,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });

    // --- request: native /api/chat, stream:false, system→system message, tools mapped ---
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(init.body as string) as {
      stream: boolean;
      model: string;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type: string; function: { name: string; parameters: unknown } }>;
      options?: { num_predict?: number };
    };
    expect(body.stream).toBe(false);
    expect(body.model).toBe("llama3.1");
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "SECRET KIT PROMPT — must never be emitted to the client",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "weather in Paris?" });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    });
    expect(body.options?.num_predict).toBe(1024);
  });

  it("maps done_reason 'length' to max_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          message: { role: "assistant", content: "truncated…" },
          done: true,
          done_reason: "length",
          prompt_eval_count: 10,
          eval_count: 1024,
        }),
      ),
    );
    const response = await new OllamaChatProvider().sendMessage(makeRequest());
    expect(response.stopReason).toBe("max_tokens");
  });
});

// ---------------------------------------------------------------------------
// tool_use round-trip (request mapping + response parsing)
// ---------------------------------------------------------------------------

describe("OllamaChatProvider — tool_use round-trip", () => {
  it("maps prior tool_use/tool_result on the wire and parses tool_calls back to normalized blocks", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "get_weather", arguments: { city: "Paris" } } },
          ],
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 1200,
        eval_count: 42,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // A conversation that already contains an assistant tool_use and the user's tool_result.
    const request: ChatRequest = {
      model: "llama3.1",
      system: "sys",
      messages: [
        { role: "user", content: [{ type: "text", text: "weather in Paris?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "prev_1", name: "get_weather", input: { city: "Lyon" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "prev_1", content: "sunny, 21C" },
          ],
        },
      ],
      tools: [
        { name: "get_weather", description: "Get weather", inputSchema: { type: "object" } },
      ],
      maxTokens: 512,
    };

    const response = await new OllamaChatProvider().sendMessage(request);

    // --- response: tool_calls → normalized tool_use, stopReason "tool_use" ---
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "ollama_tool_0", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(response.usage.inputTokens).toBe(1200);
    expect(response.usage.outputTokens).toBe(42);

    // --- request: tool_use → assistant tool_calls; tool_result → role:"tool" message ---
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
    };
    // system, user, assistant(+tool_calls), tool
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    const assistantMsg = body.messages[2];
    expect(assistantMsg.content).toBe("Let me check.");
    expect(assistantMsg.tool_calls).toEqual([
      { function: { name: "get_weather", arguments: { city: "Lyon" } } },
    ]);
    const toolMsg = body.messages[3];
    expect(toolMsg).toEqual({ role: "tool", content: "sunny, 21C" });
  });
});

// ---------------------------------------------------------------------------
// streaming — text
// ---------------------------------------------------------------------------

describe("OllamaChatProvider.streamMessage — NDJSON text", () => {
  it("accumulates text deltas across NDJSON lines, then usage + done", async () => {
    const ndjson =
      [
        `{"message":{"role":"assistant","content":"Let me "},"done":false}`,
        `{"message":{"role":"assistant","content":"check the weather."},"done":false}`,
        `{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":1200,"eval_count":12}`,
      ].join("\n") + "\n";

    const fetchMock = vi.fn(async () => ndjsonResponse(ndjson));
    vi.stubGlobal("fetch", fetchMock);

    const events: StreamEvent[] = [];
    const response = await new OllamaChatProvider().streamMessage(makeRequest(), (e) =>
      events.push(e),
    );

    const textDeltas = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta);
    expect(textDeltas.join("")).toBe("Let me check the weather.");

    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }>;
    expect(usage).toEqual({ type: "usage", input: 1200, output: 12, cached: 0 });

    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done.stopReason).toBe("end_turn");

    expect(events.some((e) => e.type === "error")).toBe(false);

    expect(response.content).toEqual([{ type: "text", text: "Let me check the weather." }]);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 12,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });
    expect(response.stopReason).toBe("end_turn");

    // request used stream:true
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { stream: boolean }).stream).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// streaming — tool-call accumulation
// ---------------------------------------------------------------------------

describe("OllamaChatProvider.streamMessage — NDJSON tool calls", () => {
  it("emits text, then tool_use partial + complete, then usage + done(tool_use)", async () => {
    const ndjson =
      [
        `{"message":{"role":"assistant","content":"Checking…"},"done":false}`,
        `{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Paris"}}}]},"done":false}`,
        `{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":900,"eval_count":30}`,
      ].join("\n") + "\n";

    vi.stubGlobal("fetch", vi.fn(async () => ndjsonResponse(ndjson)));

    const events: StreamEvent[] = [];
    const response = await new OllamaChatProvider().streamMessage(makeRequest(), (e) =>
      events.push(e),
    );

    const toolEvents = events.filter((e) => e.type === "tool_use") as Array<
      Extract<StreamEvent, { type: "tool_use" }>
    >;
    const partials = toolEvents.filter((e) => e.inputPartial !== undefined);
    const complete = toolEvents.find((e) => e.inputComplete !== undefined);
    expect(partials.length).toBe(1);
    expect(JSON.parse(partials[0].inputPartial as string)).toEqual({ city: "Paris" });
    expect(complete?.name).toBe("get_weather");
    expect(complete?.toolUseId).toBe("ollama_tool_0");
    expect(complete?.inputComplete).toEqual({ city: "Paris" });

    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done.stopReason).toBe("tool_use");

    // assembled response: text block + tool_use block, stopReason tool_use
    expect(response.content).toEqual([
      { type: "text", text: "Checking…" },
      { type: "tool_use", id: "ollama_tool_0", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage.inputTokens).toBe(900);
    expect(response.usage.outputTokens).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

describe("OllamaChatProvider — errors", () => {
  it("sendMessage throws OllamaProviderError on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "model 'llama3.1' not found" }, 404)),
    );
    const provider = new OllamaChatProvider();
    await expect(provider.sendMessage(makeRequest())).rejects.toThrow(/not found/);
    await expect(provider.sendMessage(makeRequest())).rejects.toBeInstanceOf(OllamaProviderError);
  });

  it("streamMessage emits an error event and throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "overloaded" }, 503)),
    );
    const provider = new OllamaChatProvider();
    const events: StreamEvent[] = [];
    await expect(
      provider.streamMessage(makeRequest(), (e) => events.push(e)),
    ).rejects.toThrow(/overloaded/);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
