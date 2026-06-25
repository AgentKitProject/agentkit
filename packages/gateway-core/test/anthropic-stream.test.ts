/**
 * Streaming-parse unit test for AnthropicChatProvider.streamMessage.
 *
 * Drives the SSE parser with a RECORDED Anthropic Messages stream fixture
 * (message_start → text block → tool_use block with input_json_delta fragments
 * → message_delta → message_stop) by mocking global fetch to return a
 * ReadableStream of the raw SSE bytes — chunked across event boundaries to
 * exercise the buffering logic.
 *
 * Asserts:
 *   - normalized events: text deltas, tool_use partial/complete, usage, done
 *   - input_json_delta fragments are accumulated and parsed into inputComplete
 *   - the assembled ChatResponse has the text + tool_use content and total usage
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { AnthropicChatProvider } from "../src/adapters/anthropic/index.js";
import type { StreamEvent } from "../src/core/ports.js";
import type { ChatRequest } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Recorded SSE fixture — a real-shaped Anthropic Messages stream.
// Note the tool_use input arrives as TWO input_json_delta fragments that must
// be concatenated to form valid JSON: `{"city": "Paris"}`.
// ---------------------------------------------------------------------------

const SSE_FIXTURE = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","usage":{"input_tokens":1200,"output_tokens":0,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"check the weather."}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":0}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"get_weather","input":{}}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\": "}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":1}`,
  ``,
  `event: message_delta`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}`,
  ``,
  `event: message_stop`,
  `data: {"type":"message_stop"}`,
  ``,
].join("\n");

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

function makeRequest(): ChatRequest {
  return {
    model: "claude-sonnet-4-5",
    system: "SECRET KIT PROMPT — must never be emitted to the client",
    messages: [{ role: "user", content: [{ type: "text", text: "weather in Paris?" }] }],
    tools: [
      { name: "get_weather", description: "Get weather", inputSchema: { type: "object" } },
    ],
    maxTokens: 1024,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AnthropicChatProvider.streamMessage — SSE parsing", () => {
  it("parses text deltas, tool_use input_json_delta accumulation, usage, and done", async () => {
    const fetchMock = vi.fn(async () => sseResponse(SSE_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicChatProvider({ apiKey: "test-key" });
    const events: StreamEvent[] = [];

    const response = await provider.streamMessage(makeRequest(), (ev) => events.push(ev));

    // --- text deltas ---
    const textDeltas = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    expect(textDeltas.join("")).toBe("Let me check the weather.");

    // --- tool_use: partial fragments then a complete parsed input ---
    const toolEvents = events.filter((e) => e.type === "tool_use") as Array<
      Extract<StreamEvent, { type: "tool_use" }>
    >;
    const partials = toolEvents.filter((e) => e.inputPartial !== undefined);
    const complete = toolEvents.find((e) => e.inputComplete !== undefined);
    expect(partials.length).toBe(2);
    expect(partials.map((p) => p.inputPartial).join("")).toBe('{"city": "Paris"}');
    expect(complete?.toolUseId).toBe("toolu_9");
    expect(complete?.name).toBe("get_weather");
    expect(complete?.inputComplete).toEqual({ city: "Paris" });

    // --- usage event (cumulative) ---
    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }>;
    expect(usage).toBeDefined();
    expect(usage.input).toBe(1200);
    expect(usage.output).toBe(42);
    expect(usage.cached).toBe(200);

    // --- terminal done with the right stop reason ---
    const done = events.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
    expect(done?.stopReason).toBe("tool_use");

    // --- no error events ---
    expect(events.some((e) => e.type === "error")).toBe(false);

    // --- assembled ChatResponse ---
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 42,
      cachedReadTokens: 200,
      cachedWriteTokens: 0,
    });

    // --- the request was made with stream:true and the system prompt on the wire only ---
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { stream?: boolean; system?: string };
    expect(sentBody.stream).toBe(true);
    expect(sentBody.system).toContain("SECRET KIT PROMPT");
  });

  it("emits an error event and throws on a non-2xx response", async () => {
    const errorBody = JSON.stringify({ error: { message: "overloaded" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(errorBody, { status: 529 })),
    );

    const provider = new AnthropicChatProvider({ apiKey: "test-key" });
    const events: StreamEvent[] = [];

    await expect(
      provider.streamMessage(makeRequest(), (ev) => events.push(ev)),
    ).rejects.toThrow(/overloaded/);

    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
