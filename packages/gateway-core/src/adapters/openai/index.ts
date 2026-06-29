/**
 * OpenAI ChatProvider adapter (+ openai-compatible variant).
 *
 * Implements the `ChatProvider` port using the OpenAI Chat Completions API
 * (https://platform.openai.com/docs/api-reference/chat). The normalized
 * request/response/stream shapes are IDENTICAL to those produced by the
 * Anthropic adapter (../anthropic/index.ts) — this adapter only differs in the
 * wire format it maps to/from. AgentKitAuto's agentic loop depends on faithful
 * tool-use round-tripping, so the tool_call ↔ tool_use mapping and the
 * streaming argument accumulation mirror the Anthropic assembler exactly.
 *
 * Design notes:
 *   - Uses `fetch` directly — no OpenAI SDK dependency — to keep the package
 *     install-clean everywhere (mirrors the Anthropic adapter).
 *   - The normalized `system` prompt maps to a leading `role: "system"` message;
 *     a normalized tool_use block maps to an assistant message `tool_calls`
 *     entry; a normalized tool_result block maps to a `role: "tool"` message.
 *   - Stop reasons are normalized to the SAME strings the Anthropic adapter
 *     uses (`end_turn` | `tool_use` | `max_tokens` | `stop_sequence`).
 *   - `OpenAICompatibleChatProvider` reuses ALL of this adapter's mapping
 *     (it extends `OpenAIChatProvider`) and only changes `providerType` and the
 *     baseUrl policy (required, no OpenAI default).
 */

import type { ChatProvider, StreamEvent } from "../../core/ports.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ConversationMessage,
  TextBlock,
  TokenUsage,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../../core/types.js";

// ---------------------------------------------------------------------------
// Wire types — OpenAI Chat Completions request / response shapes
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  /** Present on full (non-streaming) messages and on the first stream delta. */
  id?: string;
  /** Always "function" for the tools we send. */
  type?: "function";
  function: {
    name?: string;
    /** JSON-stringified arguments (streamed as fragments). */
    arguments?: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Text content. `null` is allowed by OpenAI for assistant tool-call turns. */
  content?: string | null;
  /** Assistant tool-call requests. */
  tool_calls?: OpenAIToolCall[];
  /** For role:"tool" — the id of the assistant tool_call this result answers. */
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema for the function parameters. */
    parameters: Record<string, unknown>;
  };
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  max_tokens: number;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Newer responses expose cached prompt tokens here. */
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIResponseMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChoice {
  message?: OpenAIResponseMessage;
  finish_reason?: string | null;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

// ---------------------------------------------------------------------------
// Wire types — OpenAI Chat Completions streaming (SSE) chunk shapes
// ---------------------------------------------------------------------------
//
// The streaming API emits `chat.completion.chunk` objects on `data:` lines,
// terminated by a `data: [DONE]` sentinel. Each chunk carries a `choices[0]`
// with a `delta`:
//   delta.content                         → incremental assistant text
//   delta.tool_calls[].index              → which tool_call this fragment is for
//   delta.tool_calls[].id / .function.name→ present on the FIRST fragment
//   delta.tool_calls[].function.arguments → streamed JSON-string fragments
// `choices[0].finish_reason` is set on the final chunk for that choice.
// `usage` is present only when `stream_options.include_usage` is requested.

interface OpenAIStreamToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface OpenAIStreamChoice {
  delta?: {
    content?: string | null;
    tool_calls?: OpenAIStreamToolCall[];
  };
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class OpenAIChatProvider implements ChatProvider {
  readonly providerType: string = "openai";

  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly defaultModel?: string;

  constructor(options: {
    apiKey: string;
    /** Defaults to "https://api.openai.com/v1". */
    baseUrl?: string;
    /** Optional fallback model when a request omits one. */
    model?: string;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.defaultModel = options.model;
  }

  /** Auth + content headers. Overridable by subclasses if needed. */
  protected headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      ...extra,
    };
  }

  private buildBody(request: ChatRequest): OpenAIRequest {
    const body: OpenAIRequest = {
      model: request.model || this.defaultModel || "",
      messages: toOpenAIMessages(request),
      max_tokens: request.maxTokens,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toOpenAITool);
    }
    return body;
  }

  // -------------------------------------------------------------------------
  // sendMessage — non-streaming
  // -------------------------------------------------------------------------

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(request);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new OpenAIProviderError(response.status, rawBody, this.providerType);
    }

    const parsed = JSON.parse(rawBody) as OpenAIResponse;
    return fromOpenAIResponse(parsed);
  }

  // -------------------------------------------------------------------------
  // streamMessage — real SSE streaming
  // -------------------------------------------------------------------------

  /**
   * Calls Chat Completions with `stream: true` (+ usage on the final chunk),
   * parses the SSE chunk stream, emits normalized StreamEvents to `onEvent`,
   * and returns the fully assembled ChatResponse (content blocks incl. tool_use
   * + total usage).
   *
   * Tool-call arguments arrive as `delta.tool_calls[].function.arguments`
   * fragments which we accumulate per tool-call `index`, parse on completion,
   * and surface both incrementally (`inputPartial`) and once complete
   * (`inputComplete`) — identical to the Anthropic assembler's behaviour.
   */
  async streamMessage(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse> {
    const body: OpenAIRequest & {
      stream: true;
      stream_options: { include_usage: true };
    } = {
      ...this.buildBody(request),
      stream: true,
      // Ask OpenAI to emit a final usage-only chunk (otherwise usage is null
      // throughout a streamed response).
      stream_options: { include_usage: true },
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers({ accept: "text/event-stream" }),
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw new OpenAIProviderError(
        0,
        JSON.stringify({ error: { message } }),
        this.providerType,
      );
    }

    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => "");
      const providerErr = new OpenAIProviderError(response.status, raw, this.providerType);
      onEvent({ type: "error", message: providerErr.message });
      throw providerErr;
    }

    const assembler = new OpenAIStreamAssembler();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEventBlock = (rawBlock: string): void => {
      // An SSE event block is a set of `field: value` lines. We only care about
      // `data:` lines (the JSON payload).
      const dataLines: string[] = [];
      for (const line of rawBlock.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (data === "[DONE]") return;

      let parsed: OpenAIStreamChunk;
      try {
        parsed = JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        return; // ignore malformed/keepalive frames
      }
      for (const ev of assembler.consume(parsed)) {
        onEvent(ev);
      }
    };

    try {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
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
      throw new OpenAIProviderError(
        0,
        JSON.stringify({ error: { message } }),
        this.providerType,
      );
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      handleEventBlock(buffer);
    }

    return assembler.finalize(onEvent);
  }
}

/**
 * OpenAI-compatible ChatProvider for any server speaking the Chat Completions
 * wire format (Together, Groq, vLLM, Ollama's OpenAI-compat endpoint, LM Studio,
 * a self-hosted gateway, …). It reuses ALL of `OpenAIChatProvider`'s
 * request/response/stream mapping verbatim — the only differences are:
 *   - `providerType` is "openai-compatible"
 *   - `baseUrl` is REQUIRED (there is no api.openai.com default)
 */
export class OpenAICompatibleChatProvider extends OpenAIChatProvider {
  readonly providerType: string = "openai-compatible";

  constructor(options: {
    apiKey: string;
    /** REQUIRED — the OpenAI-compatible endpoint base URL. */
    baseUrl: string;
    model?: string;
  }) {
    if (!options.baseUrl || options.baseUrl.trim() === "") {
      throw new Error(
        "OpenAICompatibleChatProvider requires an explicit baseUrl (the " +
          "OpenAI-compatible endpoint); there is no default.",
      );
    }
    super(options);
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
 * Stateful accumulator for the OpenAI Chat Completions SSE stream. Converts
 * wire chunks into normalized StreamEvents and builds the final ChatResponse.
 *
 * Text deltas accumulate into a single text block. Tool calls are keyed by the
 * stream's `delta.tool_calls[].index`; the id + function name arrive on the
 * first fragment and the JSON `arguments` stream as fragments which we
 * concatenate until the stream stops, then parse — emitting `inputPartial` per
 * fragment and a single `inputComplete` at finalize, mirroring the Anthropic
 * assembler.
 */
class OpenAIStreamAssembler {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedReadTokens = 0;
  private cachedWriteTokens = 0;
  private stopReason = "end_turn";
  private usageEmitted = false;

  /** Accumulated assistant text (a single text block, OpenAI-style). */
  private text = "";
  private sawText = false;

  /** In-flight tool calls keyed by the stream `index`. */
  private toolCalls = new Map<
    number,
    { id: string; name: string; argsJson: string; input: Record<string, unknown> }
  >();
  /** Preserves first-seen order of tool-call indices for the content array. */
  private toolOrder: number[] = [];

  consume(chunk: OpenAIStreamChunk): StreamEvent[] {
    const out: StreamEvent[] = [];

    // A usage-only final chunk has no choices.
    if (chunk.usage) this.applyUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta;

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        this.text += delta.content;
        this.sawText = true;
        out.push({ type: "text", delta: delta.content });
      }

      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        let entry = this.toolCalls.get(index);
        if (!entry) {
          entry = { id: tc.id ?? "", name: tc.function?.name ?? "", argsJson: "", input: {} };
          this.toolCalls.set(index, entry);
          this.toolOrder.push(index);
        }
        // id / name may only appear on the first fragment.
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;

        const fragment = tc.function?.arguments;
        if (typeof fragment === "string" && fragment.length > 0) {
          entry.argsJson += fragment;
          out.push({
            type: "tool_use",
            toolUseId: entry.id,
            name: entry.name,
            inputPartial: fragment,
          });
        }
      }

      if (choice.finish_reason) {
        this.stopReason = mapFinishReason(choice.finish_reason);
      }
    }

    return out;
  }

  /** Emits the terminal tool_use completions, `usage`, and `done`; returns the response. */
  finalize(onEvent: (event: StreamEvent) => void): ChatResponse {
    // Emit a single inputComplete per accumulated tool call (in stream order),
    // matching the Anthropic assembler's content_block_stop behaviour.
    for (const index of this.toolOrder) {
      const entry = this.toolCalls.get(index)!;
      entry.input = parseToolInput(entry.argsJson);
      onEvent({
        type: "tool_use",
        toolUseId: entry.id,
        name: entry.name,
        inputComplete: entry.input,
      });
    }

    onEvent({
      type: "usage",
      input: this.inputTokens,
      output: this.outputTokens,
      cached: this.cachedReadTokens,
    });
    this.usageEmitted = true;

    onEvent({ type: "done", stopReason: this.stopReason });

    const content: ContentBlock[] = [];
    if (this.sawText) {
      content.push({ type: "text", text: this.text });
    }
    for (const index of this.toolOrder) {
      const entry = this.toolCalls.get(index)!;
      content.push({ type: "tool_use", id: entry.id, name: entry.name, input: entry.input });
    }

    const usage: TokenUsage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedReadTokens: this.cachedReadTokens,
      cachedWriteTokens: this.cachedWriteTokens,
    };

    return { content, stopReason: this.stopReason, usage };
  }

  private applyUsage(usage: OpenAIUsage): void {
    if (typeof usage.prompt_tokens === "number") this.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") this.outputTokens = usage.completion_tokens;
    const cached = usage.prompt_tokens_details?.cached_tokens;
    if (typeof cached === "number") this.cachedReadTokens = cached;
  }
}

/** Parses accumulated tool-input JSON-string; empty string → `{}`. */
function parseToolInput(argsJson: string): Record<string, unknown> {
  const trimmed = argsJson.trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Stop-reason mapping (OpenAI finish_reason → normalized Anthropic-style)
// ---------------------------------------------------------------------------

/**
 * Normalizes an OpenAI `finish_reason` to the SAME stop-reason strings the
 * Anthropic adapter / ChatResponse contract uses:
 *   stop           → end_turn
 *   tool_calls     → tool_use      (the value Anthropic uses for tool-use stops)
 *   function_call  → tool_use      (legacy alias)
 *   length         → max_tokens
 *   content_filter → stop_sequence (closest normalized analogue)
 *   (anything else / null) → end_turn
 */
function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Mirrors the SHAPE of `AnthropicProviderError` (status, rawBody, parsed
 * message) so callers handle provider errors uniformly. Named for OpenAI so the
 * error's `name`/message correctly identify the provider that failed.
 */
export class OpenAIProviderError extends Error {
  readonly status: number;
  readonly rawBody: string;

  constructor(status: number, rawBody: string, providerLabel = "openai") {
    const message = parseOpenAIErrorMessage(status, rawBody, providerLabel);
    super(message);
    this.name = "OpenAIProviderError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

function parseOpenAIErrorMessage(status: number, body: string, providerLabel: string): string {
  const label = providerLabel === "openai-compatible" ? "OpenAI-compatible" : "OpenAI";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const msg = parsed?.error?.message;
    if (msg) return `${label} request failed (${status}): ${msg}`;
  } catch {
    // fall through
  }
  return `${label} request failed (${status})`;
}

// ---------------------------------------------------------------------------
// Managed-provider factories (read the platform key from env)
// ---------------------------------------------------------------------------

/**
 * Constructs an OpenAIChatProvider for MANAGED billing mode, reading the
 * platform OpenAI API key from `OPENAI_API_KEY`. Throws a clear, inert error at
 * composition time if the key is missing (managed mode disabled). BYO mode does
 * NOT use this factory.
 */
export function createManagedOpenAIProvider(options?: {
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  model?: string;
}): OpenAIChatProvider {
  const env = options?.env ?? process.env;
  const apiKey = env["OPENAI_API_KEY"];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "OPENAI_API_KEY is required for managed inference mode but is not set. " +
        "Provision the platform OpenAI API key (env OPENAI_API_KEY) to enable " +
        "managed (credit-billed) turns. BYO mode does not require this.",
    );
  }
  return new OpenAIChatProvider({ apiKey, baseUrl: options?.baseUrl, model: options?.model });
}

// ---------------------------------------------------------------------------
// Wire-format converters — request (normalized → OpenAI)
// ---------------------------------------------------------------------------

/**
 * Maps the normalized ChatRequest to OpenAI's flat `messages` array.
 *
 * The injected `system` prompt becomes a leading `role:"system"` message. Then
 * each ConversationMessage is mapped — but unlike Anthropic, OpenAI does NOT
 * nest tool_use / tool_result inside a message's content array:
 *   - an assistant message with tool_use block(s) → ONE assistant message with
 *     `tool_calls` (plus any leading text as `content`).
 *   - a user message carrying tool_result block(s) → ONE `role:"tool"` message
 *     PER tool_result (each keyed by its `tool_call_id`), emitted in place;
 *     any sibling text blocks become a separate `role:"user"` message.
 */
function toOpenAIMessages(request: ChatRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (request.system && request.system.length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  for (const msg of request.messages) {
    messages.push(...toOpenAIMessagesFromConversation(msg));
  }
  return messages;
}

function toOpenAIMessagesFromConversation(msg: ConversationMessage): OpenAIMessage[] {
  const textBlocks = msg.content.filter((b): b is TextBlock => b.type === "text");
  const toolUseBlocks = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const toolResultBlocks = msg.content.filter(
    (b): b is ToolResultBlock => b.type === "tool_result",
  );

  const out: OpenAIMessage[] = [];

  if (msg.role === "assistant") {
    const text = textBlocks.map((b) => b.text).join("");
    const message: OpenAIMessage = { role: "assistant" };
    // OpenAI wants null content (not "") when only tool_calls are present.
    message.content = text.length > 0 ? text : null;
    if (toolUseBlocks.length > 0) {
      message.tool_calls = toolUseBlocks.map(toOpenAIToolCall);
    }
    out.push(message);
    return out;
  }

  // role === "user": tool_result blocks become standalone role:"tool" messages.
  // Any text in the same turn becomes a normal user message (emitted first so
  // the order user-text → tool-results matches authoring order well enough; in
  // practice a turn carries either text OR tool results, not both).
  if (textBlocks.length > 0) {
    out.push({ role: "user", content: textBlocks.map((b) => b.text).join("") });
  }
  for (const tr of toolResultBlocks) {
    out.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: toolResultContentToString(tr.content),
    });
  }
  // A user turn with neither text nor tool_result (degenerate) → empty user msg.
  if (out.length === 0) {
    out.push({ role: "user", content: "" });
  }
  return out;
}

function toolResultContentToString(content: string | TextBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => c.text).join("");
}

function toOpenAIToolCall(block: ToolUseBlock): OpenAIToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  };
}

function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

// ---------------------------------------------------------------------------
// Wire-format converters — response (OpenAI → normalized)
// ---------------------------------------------------------------------------

function fromOpenAIResponse(raw: OpenAIResponse): ChatResponse {
  const choice = raw.choices?.[0];
  const message = choice?.message;

  const content: ContentBlock[] = [];
  if (typeof message?.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const tc of message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      input: parseToolInput(tc.function?.arguments ?? ""),
    });
  }

  const usage: TokenUsage = {
    inputTokens: raw.usage?.prompt_tokens ?? 0,
    outputTokens: raw.usage?.completion_tokens ?? 0,
    cachedReadTokens: raw.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cachedWriteTokens: 0,
  };

  return {
    content,
    stopReason: mapFinishReason(choice?.finish_reason),
    usage,
  };
}
