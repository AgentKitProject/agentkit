/**
 * Anthropic ChatProvider adapter.
 *
 * Implements the `ChatProvider` port using the Anthropic Messages API
 * (https://docs.anthropic.com/en/api/messages).
 *
 * Design notes:
 *   - Uses `fetch` directly — no Anthropic SDK dependency — to keep the
 *     package install-clean everywhere (mirrors the pattern in
 *     agentkitforge/server/core/ai-draft.ts).
 *   - Prompt-cache headers (anthropic-beta: prompt-caching-2024-07-31) are
 *     included so large system prompts (the injected kit instructions) benefit
 *     from Anthropic's prompt caching automatically.
 *   - Non-streaming `sendMessage` is fully implemented for Phase 0.
 *   - `streamMessage` is scaffolded: it accepts the request + callback
 *     signature but currently calls `sendMessage` and synthesises events,
 *     keeping the interface compile-time-valid. True SSE streaming is
 *     Phase 1 work.
 *
 * The adapter is constructed with an API key. In managed billing mode the
 * gateway's own Anthropic key is injected at composition; in BYO mode the
 * caller-supplied key is injected per-call (the composition root is
 * responsible for choosing which key to use).
 */

import type {
  ChatProvider,
  StreamEvent,
} from "../../core/ports.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  TokenUsage,
  ToolDefinition,
  ToolResultBlock,
} from "../../core/types.js";

// ---------------------------------------------------------------------------
// Wire types — Anthropic Messages API request / response shapes
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  max_tokens: number;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: AnthropicUsage;
}

// ---------------------------------------------------------------------------
// Wire types — Anthropic Messages streaming (SSE) event shapes
// ---------------------------------------------------------------------------
//
// The streaming API emits a sequence of typed events:
//   message_start      → { message: { usage } }            (input usage seed)
//   content_block_start→ { index, content_block }          (text | tool_use)
//   content_block_delta→ { index, delta }                  (text_delta | input_json_delta)
//   content_block_stop → { index }
//   message_delta      → { delta: { stop_reason }, usage }  (output usage)
//   message_stop
//   ping / error
//
// We parse `data:` payloads, switch on `type`, and emit normalized StreamEvents.

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: {
    stop_reason?: string | null;
    usage?: Partial<AnthropicUsage>;
  };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: Partial<AnthropicUsage>;
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class AnthropicChatProvider implements ChatProvider {
  readonly providerType = "anthropic" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    /** Defaults to "https://api.anthropic.com/v1". */
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
  }

  // -------------------------------------------------------------------------
  // sendMessage — non-streaming, fully implemented
  // -------------------------------------------------------------------------

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const body: AnthropicRequest = {
      model: request.model,
      system: request.system,
      messages: request.messages.map(toAnthropicMessage),
      max_tokens: request.maxTokens,
    };

    if (request.tools.length > 0) {
      body.tools = request.tools.map(toAnthropicTool);
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        // Enable prompt caching for large system prompts (kit instructions).
        "anthropic-beta": "prompt-caching-2024-07-31",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new AnthropicProviderError(response.status, rawBody);
    }

    const parsed = JSON.parse(rawBody) as AnthropicResponse;
    return fromAnthropicResponse(parsed);
  }

  // -------------------------------------------------------------------------
  // streamMessage — real SSE streaming
  // -------------------------------------------------------------------------

  /**
   * Calls the Anthropic Messages API with `stream: true`, parses the SSE event
   * stream, emits normalized StreamEvents to `onEvent`, and returns the fully
   * assembled ChatResponse (content blocks incl. tool_use + total usage).
   *
   * Tool-use input arrives as `input_json_delta` fragments which we accumulate
   * per content-block index, parse on `content_block_stop`, and surface both
   * incrementally (`inputPartial`) and once complete (`inputComplete`).
   */
  async streamMessage(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse> {
    const body: AnthropicRequest & { stream: true } = {
      model: request.model,
      system: request.system,
      messages: request.messages.map(toAnthropicMessage),
      max_tokens: request.maxTokens,
      stream: true,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toAnthropicTool);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw new AnthropicProviderError(0, JSON.stringify({ error: { message } }));
    }

    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => "");
      const providerErr = new AnthropicProviderError(response.status, raw);
      onEvent({ type: "error", message: providerErr.message });
      throw providerErr;
    }

    // Accumulator state assembled from the SSE event stream.
    const assembler = new StreamAssembler();

    const decoder = new TextDecoder();
    let buffer = "";

    const handleEventBlock = (rawBlock: string): void => {
      // An SSE event block is a set of `field: value` lines. We only care
      // about `data:` lines (the JSON payload). `event:` lines are redundant
      // with the payload's own `type`.
      const dataLines: string[] = [];
      for (const line of rawBlock.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (data === "[DONE]") return;

      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        return; // ignore malformed/keepalive frames
      }
      for (const ev of assembler.consume(parsed)) {
        onEvent(ev);
      }
    };

    try {
      // Web ReadableStream (fetch in Node 22+, browsers, edge runtimes).
      const reader = (
        response.body as ReadableStream<Uint8Array>
      ).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE event blocks are delimited by a blank line.
        let sepIndex: number;
        while ((sepIndex = indexOfDoubleNewline(buffer)) !== -1) {
          const block = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex).replace(/^(\r?\n){1,2}/, "");
          handleEventBlock(block);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw new AnthropicProviderError(0, JSON.stringify({ error: { message } }));
    }

    // Flush any trailing buffered block.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      handleEventBlock(buffer);
    }

    return assembler.finalize(onEvent);
  }
}

// ---------------------------------------------------------------------------
// SSE stream assembler
// ---------------------------------------------------------------------------

/** Returns the index of the first `\n\n` or `\r\n\r\n` in `s`, or -1. */
function indexOfDoubleNewline(s: string): number {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/**
 * Stateful accumulator for the Anthropic Messages SSE stream. Converts wire
 * events into normalized StreamEvents and builds the final ChatResponse.
 *
 * Per content-block index it tracks whether the block is text or tool_use and,
 * for tool_use, accumulates the `input_json_delta` partial-JSON fragments until
 * `content_block_stop`, at which point the input is parsed.
 */
class StreamAssembler {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedReadTokens = 0;
  private cachedWriteTokens = 0;
  private stopReason = "end_turn";

  /** In-flight content blocks keyed by SSE `index`. */
  private blocks = new Map<
    number,
    | { kind: "text"; text: string }
    | { kind: "tool_use"; id: string; name: string; partialJson: string; input: Record<string, unknown> }
  >();
  /** Preserves emission order of blocks for the final content array. */
  private order: number[] = [];

  /** Whether we have already emitted a `usage` event. */
  private usageEmitted = false;

  consume(ev: AnthropicStreamEvent): StreamEvent[] {
    const out: StreamEvent[] = [];

    switch (ev.type) {
      case "message_start": {
        this.applyUsage(ev.message?.usage);
        break;
      }
      case "content_block_start": {
        const index = ev.index ?? 0;
        const cb = ev.content_block;
        if (cb?.type === "tool_use") {
          this.blocks.set(index, {
            kind: "tool_use",
            id: cb.id ?? "",
            name: cb.name ?? "",
            partialJson: "",
            input: {},
          });
          this.order.push(index);
        } else {
          // text (or unknown → treat as text)
          this.blocks.set(index, { kind: "text", text: cb?.text ?? "" });
          this.order.push(index);
          if (cb?.text) out.push({ type: "text", delta: cb.text });
        }
        break;
      }
      case "content_block_delta": {
        const index = ev.index ?? 0;
        const block = this.blocks.get(index);
        const delta = ev.delta;
        if (!block || !delta) break;
        if (delta.type === "text_delta" && block.kind === "text") {
          block.text += delta.text ?? "";
          out.push({ type: "text", delta: delta.text ?? "" });
        } else if (delta.type === "input_json_delta" && block.kind === "tool_use") {
          const fragment = delta.partial_json ?? "";
          block.partialJson += fragment;
          out.push({
            type: "tool_use",
            toolUseId: block.id,
            name: block.name,
            inputPartial: fragment,
          });
        }
        break;
      }
      case "content_block_stop": {
        const index = ev.index ?? 0;
        const block = this.blocks.get(index);
        if (block && block.kind === "tool_use") {
          block.input = parseToolInput(block.partialJson);
          out.push({
            type: "tool_use",
            toolUseId: block.id,
            name: block.name,
            inputComplete: block.input,
          });
        }
        break;
      }
      case "message_delta": {
        if (ev.delta?.stop_reason) this.stopReason = ev.delta.stop_reason;
        this.applyUsage(ev.usage);
        // Anthropic reports cumulative output usage here — surface it once.
        out.push({
          type: "usage",
          input: this.inputTokens,
          output: this.outputTokens,
          cached: this.cachedReadTokens,
        });
        this.usageEmitted = true;
        break;
      }
      case "error": {
        out.push({ type: "error", message: ev.error?.message ?? "stream error" });
        break;
      }
      // message_stop / ping → no normalized event here; `done` is emitted in finalize.
      default:
        break;
    }

    return out;
  }

  /** Emits the terminal `usage` + `done` events and returns the ChatResponse. */
  finalize(onEvent: (event: StreamEvent) => void): ChatResponse {
    if (!this.usageEmitted) {
      onEvent({
        type: "usage",
        input: this.inputTokens,
        output: this.outputTokens,
        cached: this.cachedReadTokens,
      });
    }
    onEvent({ type: "done", stopReason: this.stopReason });

    const content: ContentBlock[] = this.order.map((index) => {
      const block = this.blocks.get(index)!;
      if (block.kind === "text") {
        return { type: "text", text: block.text };
      }
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    });

    const usage: TokenUsage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedReadTokens: this.cachedReadTokens,
      cachedWriteTokens: this.cachedWriteTokens,
    };

    return { content, stopReason: this.stopReason, usage };
  }

  private applyUsage(usage?: Partial<AnthropicUsage>): void {
    if (!usage) return;
    if (typeof usage.input_tokens === "number") this.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") this.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number") {
      this.cachedReadTokens = usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
      this.cachedWriteTokens = usage.cache_creation_input_tokens;
    }
  }
}

/** Parses accumulated tool-input partial JSON; empty string → `{}`. */
function parseToolInput(partialJson: string): Record<string, unknown> {
  const trimmed = partialJson.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Constructs an AnthropicChatProvider for MANAGED billing mode, reading the
 * platform Anthropic API key from the `ANTHROPIC_API_KEY` environment variable.
 *
 * REQUIRED FOR MANAGED INFERENCE: managed turns use OUR platform key. If
 * `ANTHROPIC_API_KEY` is unset (or empty) this throws a clear, inert error at
 * composition time — the gateway never attempts an unauthenticated provider
 * call. BYO mode does NOT use this factory (it injects the caller's key).
 *
 * @param env       Defaults to `process.env`. Injectable for tests.
 * @param baseUrl   Optional override of the Anthropic API base URL.
 * @throws Error    if `ANTHROPIC_API_KEY` is missing — managed mode is disabled.
 */
export function createManagedAnthropicProvider(options?: {
  env?: Record<string, string | undefined>;
  baseUrl?: string;
}): AnthropicChatProvider {
  const env = options?.env ?? process.env;
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is required for managed inference mode but is not set. " +
        "Provision the platform Anthropic API key (env ANTHROPIC_API_KEY) to enable " +
        "managed (credit-billed) turns. BYO mode does not require this.",
    );
  }
  return new AnthropicChatProvider({ apiKey, baseUrl: options?.baseUrl });
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class AnthropicProviderError extends Error {
  readonly status: number;
  readonly rawBody: string;

  constructor(status: number, rawBody: string) {
    const message = parseAnthropicErrorMessage(status, rawBody);
    super(message);
    this.name = "AnthropicProviderError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

function parseAnthropicErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const msg = parsed?.error?.message;
    if (msg) return `Anthropic request failed (${status}): ${msg}`;
  } catch {
    // fall through
  }
  return `Anthropic request failed (${status})`;
}

// ---------------------------------------------------------------------------
// Wire-format converters
// ---------------------------------------------------------------------------

function toAnthropicMessage(msg: { role: "user" | "assistant"; content: ContentBlock[] }): AnthropicMessage {
  return {
    role: msg.role,
    content: msg.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(block: ContentBlock): AnthropicContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result": {
      const trBlock = block as ToolResultBlock;
      return {
        type: "tool_result",
        tool_use_id: trBlock.tool_use_id,
        content: typeof trBlock.content === "string"
          ? trBlock.content
          : trBlock.content.map((c) => ({ type: "text", text: c.text })),
      };
    }
    default: {
      // Unreachable in well-typed code, but provide a safe fallback.
      const never = block as { type: string };
      throw new Error(`Unknown content block type: ${never.type}`);
    }
  }
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function fromAnthropicResponse(raw: AnthropicResponse): ChatResponse {
  const content: ContentBlock[] = (raw.content ?? []).map(fromAnthropicContentBlock);
  const usage: TokenUsage = {
    inputTokens: raw.usage.input_tokens,
    outputTokens: raw.usage.output_tokens,
    cachedReadTokens: raw.usage.cache_read_input_tokens ?? 0,
    cachedWriteTokens: raw.usage.cache_creation_input_tokens ?? 0,
  };
  return {
    content,
    stopReason: raw.stop_reason ?? "end_turn",
    usage,
  };
}

function fromAnthropicContentBlock(block: AnthropicContentBlock): ContentBlock {
  if (block.type === "text") {
    return { type: "text", text: block.text ?? "" };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id ?? "",
      name: block.name ?? "",
      input: block.input ?? {},
    };
  }
  // Unknown block type — convert to text (safe fallback).
  return { type: "text", text: JSON.stringify(block) };
}
