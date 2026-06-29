/**
 * Ollama ChatProvider adapter.
 *
 * Implements the `ChatProvider` port using Ollama's NATIVE chat API
 * (POST /api/chat — https://github.com/ollama/ollama/blob/main/docs/api.md),
 * NOT the OpenAI-compatibility shim. The native API supports tool calling,
 * which AgentKitAuto's agentic run loop depends on.
 *
 * Ollama is the LOCAL / SELF-HOST provider: by default it runs on
 * http://localhost:11434 with NO authentication. The constructor accepts an
 * optional `apiKey` for the rare case of a proxied / authenticated Ollama
 * endpoint (sent as `Authorization: Bearer …`); for plain local Ollama it is
 * simply omitted.
 *
 * Normalization contract (must match the Anthropic adapter exactly so the
 * core / run loop is provider-agnostic):
 *   - normalized `system`            → an Ollama `role:"system"` message
 *   - normalized text block          → Ollama message `content`
 *   - normalized `tool_use` block    → an assistant message `tool_calls` entry
 *                                      `{ function: { name, arguments: {…} } }`
 *   - normalized `tool_result` block → an Ollama `role:"tool"` message
 *   - normalized `tools` list        → Ollama
 *                                      `tools:[{type:"function",function:{…}}]`
 *
 * Response mapping (both /api/chat and streaming):
 *   - `message.content`              → a normalized text block
 *   - `message.tool_calls[]`         → normalized tool_use blocks (Ollama
 *                                      returns `arguments` already as an OBJECT,
 *                                      so no partial-JSON parsing is needed)
 *   - `done_reason` / `done`         → normalized stop reason (see
 *                                      `mapStopReason`); a response carrying
 *                                      tool_calls maps to "tool_use" to match
 *                                      Anthropic
 *   - `prompt_eval_count`/`eval_count` → normalized usage (input / output).
 *     Ollama has no prompt cache → cachedRead / cachedWrite are always 0.
 *
 * Streaming transport difference vs Anthropic: Ollama streams
 * NEWLINE-DELIMITED JSON (NDJSON) when `stream:true`, NOT SSE. Each line is a
 * complete partial object `{message:{content, tool_calls?}, done}`. We split on
 * newlines (buffering partial lines across chunks), parse each line as one JSON
 * object, accumulate `message.content` into text StreamEvents and any
 * `message.tool_calls` into normalized tool_use events, and emit usage + done at
 * the terminal (`done:true`) frame.
 */

import type { ChatProvider, StreamEvent } from "../../core/ports.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  TokenUsage,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../../core/types.js";

// ---------------------------------------------------------------------------
// Wire types — Ollama native /api/chat request / response shapes
// ---------------------------------------------------------------------------

interface OllamaToolCall {
  function: {
    name: string;
    /** Ollama returns/accepts arguments as a JSON OBJECT (not a string). */
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that request tool calls. */
  tool_calls?: OllamaToolCall[];
  /**
   * On a `role:"tool"` message, the name of the tool whose result this is.
   * Ollama tolerates its absence, but newer servers use it to correlate the
   * result with the preceding tool_call.
   */
  tool_name?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: boolean;
  /** Ollama maps `num_predict` to the max generated tokens. */
  options?: { num_predict?: number };
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  /** "stop" | "length" | "load" | … ; absent on intermediate stream frames. */
  done_reason?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class OllamaChatProvider implements ChatProvider {
  readonly providerType = "ollama" as const;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;

  constructor(options?: {
    /** Usually unused for local Ollama. If set, sent as `Authorization: Bearer …`. */
    apiKey?: string;
    /** Defaults to "http://localhost:11434". */
    baseUrl?: string;
    /** Fallback model when a ChatRequest does not specify one. */
    model?: string;
  }) {
    this.apiKey = options?.apiKey;
    this.baseUrl = (options?.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.defaultModel = options?.model;
  }

  // -------------------------------------------------------------------------
  // sendMessage — non-streaming (stream:false)
  // -------------------------------------------------------------------------

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, false);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new OllamaProviderError(response.status, rawBody);
    }

    const parsed = JSON.parse(rawBody) as OllamaChatResponse;
    return fromOllamaResponse(parsed);
  }

  // -------------------------------------------------------------------------
  // streamMessage — NDJSON streaming (stream:true)
  // -------------------------------------------------------------------------

  /**
   * Calls /api/chat with `stream:true`, parses the NDJSON stream (one JSON
   * object per line), emits normalized StreamEvents to `onEvent`, and returns
   * the fully assembled ChatResponse.
   *
   * Unlike Anthropic's SSE/partial-JSON tool deltas, Ollama delivers each
   * tool_call with its `arguments` already as a complete object, typically in a
   * single frame. We mirror the Anthropic assembler's externally-visible
   * behavior: for each tool_call we surface an incremental `inputPartial`
   * (the serialized arguments) followed by a terminal `inputComplete` (the
   * parsed object), and we assemble the same final content array shape.
   */
  async streamMessage(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse> {
    const body = this.buildRequestBody(request, true);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw new OllamaProviderError(0, JSON.stringify({ error: message }));
    }

    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => "");
      const providerErr = new OllamaProviderError(response.status, raw);
      onEvent({ type: "error", message: providerErr.message });
      throw providerErr;
    }

    const assembler = new StreamAssembler();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let parsed: OllamaChatResponse;
      try {
        parsed = JSON.parse(trimmed) as OllamaChatResponse;
      } catch {
        return; // ignore malformed / partial keepalive lines
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
        // NDJSON: split on newline; keep the trailing partial line in `buffer`.
        let nlIndex: number;
        while ((nlIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIndex);
          buffer = buffer.slice(nlIndex + 1);
          handleLine(line);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw new OllamaProviderError(0, JSON.stringify({ error: message }));
    }

    // Flush any trailing buffered line (NDJSON streams may omit a final newline).
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      handleLine(buffer);
    }

    return assembler.finalize(onEvent);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey && this.apiKey.trim() !== "") {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildRequestBody(request: ChatRequest, stream: boolean): OllamaRequest {
    const messages: OllamaMessage[] = [];
    // Normalized `system` → a leading system-role message.
    if (request.system && request.system.length > 0) {
      messages.push({ role: "system", content: request.system });
    }
    for (const msg of request.messages) {
      messages.push(...toOllamaMessages(msg));
    }

    const body: OllamaRequest = {
      model: request.model || this.defaultModel || "",
      messages,
      stream,
    };
    if (typeof request.maxTokens === "number") {
      body.options = { num_predict: request.maxTokens };
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toOllamaTool);
    }
    return body;
  }
}

// ---------------------------------------------------------------------------
// NDJSON stream assembler
// ---------------------------------------------------------------------------

/**
 * Stateful accumulator for the Ollama NDJSON chat stream. Converts wire frames
 * into normalized StreamEvents and builds the final ChatResponse.
 *
 * Each frame may carry incremental `message.content` (text) and/or
 * `message.tool_calls` (already-complete objects). The terminal frame
 * (`done:true`) carries `done_reason` + token counts.
 */
class StreamAssembler {
  private text = "";
  private readonly toolUses: ToolUseBlock[] = [];
  /** Tracks block emission order (text first if any, then tool_use blocks). */
  private sawText = false;

  private inputTokens = 0;
  private outputTokens = 0;
  private rawDoneReason: string | undefined;
  private sawToolCalls = false;
  private usageEmitted = false;
  private toolCounter = 0;

  consume(frame: OllamaChatResponse): StreamEvent[] {
    const out: StreamEvent[] = [];
    const message = frame.message;

    if (message) {
      if (typeof message.content === "string" && message.content.length > 0) {
        this.text += message.content;
        this.sawText = true;
        out.push({ type: "text", delta: message.content });
      }

      if (Array.isArray(message.tool_calls)) {
        this.sawToolCalls = true;
        for (const call of message.tool_calls) {
          const name = call.function?.name ?? "";
          const input = normalizeToolArguments(call.function?.arguments);
          // Ollama does not provide tool-call IDs; synthesize a stable one.
          const toolUseId = `ollama_tool_${this.toolCounter++}`;
          this.toolUses.push({ type: "tool_use", id: toolUseId, name, input });
          // Mirror Anthropic's externally-visible behavior: an incremental
          // `inputPartial` (the serialized args) then a terminal
          // `inputComplete` (the parsed object).
          out.push({
            type: "tool_use",
            toolUseId,
            name,
            inputPartial: JSON.stringify(input),
          });
          out.push({
            type: "tool_use",
            toolUseId,
            name,
            inputComplete: input,
          });
        }
      }
    }

    if (frame.done) {
      if (typeof frame.prompt_eval_count === "number") {
        this.inputTokens = frame.prompt_eval_count;
      }
      if (typeof frame.eval_count === "number") {
        this.outputTokens = frame.eval_count;
      }
      this.rawDoneReason = frame.done_reason;
      out.push({
        type: "usage",
        input: this.inputTokens,
        output: this.outputTokens,
        cached: 0,
      });
      this.usageEmitted = true;
    }

    return out;
  }

  finalize(onEvent: (event: StreamEvent) => void): ChatResponse {
    if (!this.usageEmitted) {
      onEvent({ type: "usage", input: this.inputTokens, output: this.outputTokens, cached: 0 });
    }

    const stopReason = mapStopReason(this.rawDoneReason, this.sawToolCalls);
    onEvent({ type: "done", stopReason });

    const content: ContentBlock[] = [];
    if (this.sawText) {
      content.push({ type: "text", text: this.text });
    }
    for (const tu of this.toolUses) {
      content.push(tu);
    }

    const usage: TokenUsage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    };

    return { content, stopReason, usage };
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class OllamaProviderError extends Error {
  readonly status: number;
  readonly rawBody: string;

  constructor(status: number, rawBody: string) {
    super(parseOllamaErrorMessage(status, rawBody));
    this.name = "OllamaProviderError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

function parseOllamaErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } };
    const err = parsed?.error;
    const msg = typeof err === "string" ? err : err?.message;
    if (msg) return `Ollama request failed (${status}): ${msg}`;
  } catch {
    // fall through
  }
  return `Ollama request failed (${status})`;
}

// ---------------------------------------------------------------------------
// Managed-mode factory
// ---------------------------------------------------------------------------

/**
 * Constructs an OllamaChatProvider for a self-hosted / managed deployment,
 * reading the (optional) endpoint + key from the environment.
 *
 * Local Ollama needs no API key, so — unlike the Anthropic managed factory —
 * this NEVER throws on a missing key: a self-hosted operator pointing the
 * gateway at a local Ollama is the expected path.
 *
 *   - `OLLAMA_BASE_URL`  → base URL (default http://localhost:11434)
 *   - `OLLAMA_API_KEY`   → optional bearer token for a proxied endpoint
 *   - `OLLAMA_MODEL`     → optional default model
 */
export function createManagedOllamaProvider(options?: {
  env?: Record<string, string | undefined>;
  baseUrl?: string;
}): OllamaChatProvider {
  const env = options?.env ?? process.env;
  return new OllamaChatProvider({
    apiKey: env["OLLAMA_API_KEY"],
    baseUrl: options?.baseUrl ?? env["OLLAMA_BASE_URL"],
    model: env["OLLAMA_MODEL"],
  });
}

// ---------------------------------------------------------------------------
// Wire-format converters — normalized → Ollama
// ---------------------------------------------------------------------------

/**
 * Maps one normalized ConversationMessage to one or more Ollama messages.
 *
 * A single normalized message can mix text, tool_use, and tool_result blocks:
 *   - text + tool_use blocks collapse into ONE Ollama message (content +
 *     tool_calls) under the message's role (user/assistant).
 *   - each tool_result block becomes its OWN `role:"tool"` message, because
 *     Ollama models a tool result as a distinct tool-role message.
 */
function toOllamaMessages(msg: {
  role: "user" | "assistant";
  content: ContentBlock[];
}): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  let text = "";
  const toolCalls: OllamaToolCall[] = [];
  const toolResults: OllamaMessage[] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        text += block.text;
        break;
      case "tool_use":
        toolCalls.push({
          function: { name: block.name, arguments: block.input ?? {} },
        });
        break;
      case "tool_result": {
        const tr = block as ToolResultBlock;
        toolResults.push({
          role: "tool",
          content: toolResultContentToString(tr.content),
        });
        break;
      }
      default: {
        const never = block as { type: string };
        throw new Error(`Unknown content block type: ${never.type}`);
      }
    }
  }

  // Emit the base message only if it carries text or tool calls. (A message
  // that is purely tool_result blocks contributes only tool-role messages.)
  if (text.length > 0 || toolCalls.length > 0) {
    const base: OllamaMessage = { role: msg.role, content: text };
    if (toolCalls.length > 0) base.tool_calls = toolCalls;
    out.push(base);
  }
  out.push(...toolResults);
  return out;
}

function toolResultContentToString(content: string | { type: "text"; text: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => c.text).join("");
}

function toOllamaTool(tool: ToolDefinition): OllamaTool {
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
// Wire-format converters — Ollama → normalized
// ---------------------------------------------------------------------------

function fromOllamaResponse(raw: OllamaChatResponse): ChatResponse {
  const message = raw.message;
  const content: ContentBlock[] = [];

  if (message && typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }

  let sawToolCalls = false;
  if (message && Array.isArray(message.tool_calls)) {
    sawToolCalls = message.tool_calls.length > 0;
    let counter = 0;
    for (const call of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: `ollama_tool_${counter++}`,
        name: call.function?.name ?? "",
        input: normalizeToolArguments(call.function?.arguments),
      });
    }
  }

  const usage: TokenUsage = {
    inputTokens: raw.prompt_eval_count ?? 0,
    outputTokens: raw.eval_count ?? 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };

  return {
    content,
    stopReason: mapStopReason(raw.done_reason, sawToolCalls),
    usage,
  };
}

/**
 * Maps Ollama's `done_reason` to the normalized stop reason (Anthropic strings):
 *   - any response carrying tool_calls → "tool_use"  (matches Anthropic; the
 *     run loop keys off this to dispatch tools)
 *   - "length"                         → "max_tokens"
 *   - "stop" / undefined / anything else → "end_turn"
 */
function mapStopReason(doneReason: string | undefined, sawToolCalls: boolean): string {
  if (sawToolCalls) return "tool_use";
  if (doneReason === "length") return "max_tokens";
  return "end_turn";
}

/**
 * Normalizes Ollama tool-call `arguments` into the normalized tool_use `input`
 * shape (`Record<string, unknown>`). Ollama returns an object, but be defensive:
 * tolerate a JSON string (some proxies stringify) and non-object values.
 */
function normalizeToolArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed === "") return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}
