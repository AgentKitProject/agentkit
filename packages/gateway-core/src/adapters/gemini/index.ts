/**
 * Google Gemini ChatProvider adapter.
 *
 * Implements the `ChatProvider` port using the Gemini
 * `generateContent` / `streamGenerateContent` REST API
 * (https://ai.google.dev/api/generate-content).
 *
 * Design notes (mirrors ../anthropic/index.ts):
 *   - Uses `fetch` directly — no Google SDK dependency — to keep the package
 *     install-clean everywhere.
 *   - Auth is the `x-goog-api-key` HEADER (never a `?key=` query param) so the
 *     API key is never leaked into a URL / request log.
 *   - Emits the SAME normalized shapes as the Anthropic adapter: text + tool_use
 *     content blocks, Anthropic-style stop reasons ('end_turn' | 'tool_use' |
 *     'max_tokens' | 'stop_sequence'), TokenUsage, and StreamEvents.
 *
 * Normalization mapping (the load-bearing part for AgentKitAuto's tool loop):
 *   - normalized `system`               → `systemInstruction.parts[].text`
 *   - role "assistant"                  → Gemini role "model"
 *   - role "user"                       → Gemini role "user"
 *   - normalized tool_use block (asst)  → a `functionCall` part in a MODEL content
 *   - normalized tool_result block      → a `functionResponse` part in a USER content
 *   - normalized tools[]                → `tools[0].functionDeclarations[]`
 *
 * Gemini does NOT supply tool-call ids; we synthesize a deterministic id from the
 * function name + occurrence index (see `synthToolUseId`). The normalized
 * tool_result it later flows back carries `tool_use_id`, but Gemini's
 * `functionResponse` is keyed by `name` only — so on the request side we map by
 * the function NAME, and on the response side we mint an id the gateway can use
 * to correlate the eventual tool_result. Ids stay consistent for a given
 * (name, index) so a multi-tool turn round-trips correctly.
 */

import type { ChatProvider, StreamEvent } from "../../core/ports.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ConversationMessage,
  TokenUsage,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../../core/types.js";
/** Provider-correct error (same shape as the OpenAI/Ollama adapter errors). */
export class GeminiProviderError extends Error {
  readonly status: number;
  readonly rawBody: string;

  constructor(status: number, rawBody: string) {
    super(parseGeminiErrorMessage(status, rawBody));
    this.name = "GeminiProviderError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

function parseGeminiErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const msg = parsed?.error?.message;
    if (msg) return `Gemini request failed (${status}): ${msg}`;
  } catch {
    // fall through
  }
  return `Gemini request failed (${status})`;
}

// ---------------------------------------------------------------------------
// Wire types — Gemini generateContent request / response shapes
// ---------------------------------------------------------------------------

interface GeminiTextPart {
  text: string;
}

interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args?: Record<string, unknown>;
  };
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiTextPart[] };
  tools?: GeminiTool[];
  generationConfig?: { maxOutputTokens?: number };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class GeminiChatProvider implements ChatProvider {
  readonly providerType = "gemini" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;

  constructor(options: {
    apiKey: string;
    /** Defaults to "https://generativelanguage.googleapis.com/v1beta". */
    baseUrl?: string;
    /** Fallback model when a request omits `model`. */
    model?: string;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = (
      options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
    this.defaultModel = options.model;
  }

  // -------------------------------------------------------------------------
  // sendMessage — non-streaming
  // -------------------------------------------------------------------------

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const model = this.resolveModel(request);
    const body = toGeminiRequest(request);

    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const rawBody = await response.text();
    if (!response.ok) {
      throw new GeminiProviderError(response.status, rawBody);
    }

    const parsed = JSON.parse(rawBody) as GeminiResponse;
    return fromGeminiResponse(parsed);
  }

  // -------------------------------------------------------------------------
  // streamMessage — real SSE streaming (:streamGenerateContent?alt=sse)
  // -------------------------------------------------------------------------

  /**
   * Calls `:streamGenerateContent?alt=sse`, parses the SSE stream (each `data:`
   * line is a partial GenerateContentResponse), emits normalized StreamEvents to
   * `onEvent`, and returns the fully assembled ChatResponse.
   *
   * Unlike Anthropic's incremental `input_json_delta`, Gemini emits each
   * `functionCall` part with its `args` already a complete object, but it can
   * appear across chunks. We accumulate text per running text block and treat
   * each `functionCall` as a complete tool_use: we surface it both incrementally
   * (`inputPartial` = stringified args, to mirror the Anthropic assembler) and
   * as `inputComplete` (the parsed args object).
   */
  async streamMessage(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse> {
    const model = this.resolveModel(request);
    const body = toGeminiRequest(request);

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": this.apiKey,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message });
      throw new GeminiProviderError(0, JSON.stringify({ error: { message } }));
    }

    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => "");
      const providerErr = new GeminiProviderError(response.status, raw);
      onEvent({ type: "error", message: providerErr.message });
      throw providerErr;
    }

    const assembler = new GeminiStreamAssembler();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleEventBlock = (rawBlock: string): void => {
      // Each SSE event block has one or more `data:` lines (the JSON payload).
      const dataLines: string[] = [];
      for (const line of rawBlock.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (data === "[DONE]") return;

      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(data) as GeminiResponse;
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
      throw new GeminiProviderError(0, JSON.stringify({ error: { message } }));
    }

    // Flush any trailing buffered block.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      handleEventBlock(buffer);
    }

    return assembler.finalize(onEvent);
  }

  private resolveModel(request: ChatRequest): string {
    const model = request.model || this.defaultModel;
    if (!model || model.trim() === "") {
      throw new Error("GeminiChatProvider: no model specified on the request or adapter.");
    }
    return model;
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
 * Stateful accumulator for the Gemini `:streamGenerateContent?alt=sse` stream.
 *
 * Each chunk is a partial GenerateContentResponse whose
 * `candidates[0].content.parts` carries text and/or functionCall parts, plus an
 * optional cumulative `usageMetadata` and a `finishReason` (usually only on the
 * final chunk). We:
 *   - merge consecutive text into a single running text block (Anthropic emits
 *     one text block split into deltas — we mirror that shape);
 *   - treat each functionCall as its own tool_use block (complete args), minting
 *     a deterministic synthetic id by (name, occurrence index);
 *   - surface the latest cumulative usage and the final stop reason.
 */
class GeminiStreamAssembler {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedReadTokens = 0;
  private stopReason = "end_turn";
  private sawFunctionCall = false;

  /** Ordered assembled blocks. Text parts coalesce into the current text block. */
  private order: Array<
    | { kind: "text"; text: string }
    | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  > = [];
  /** Per-name occurrence counter for deterministic synthetic ids. */
  private toolCounts = new Map<string, number>();

  private usageEmitted = false;

  consume(chunk: GeminiResponse): StreamEvent[] {
    const out: StreamEvent[] = [];

    if (chunk.usageMetadata) {
      this.applyUsage(chunk.usageMetadata);
      out.push({
        type: "usage",
        input: this.inputTokens,
        output: this.outputTokens,
        cached: this.cachedReadTokens,
      });
      this.usageEmitted = true;
    }

    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (isTextPart(part)) {
        const text = part.text ?? "";
        if (text === "") continue;
        const last = this.order[this.order.length - 1];
        if (last && last.kind === "text") {
          last.text += text;
        } else {
          this.order.push({ kind: "text", text });
        }
        out.push({ type: "text", delta: text });
      } else if (isFunctionCallPart(part)) {
        this.sawFunctionCall = true;
        const name = part.functionCall.name;
        const input = part.functionCall.args ?? {};
        const id = synthToolUseId(name, this.nextToolIndex(name));
        this.order.push({ kind: "tool_use", id, name, input });
        // Gemini delivers args complete; surface both the partial (stringified,
        // to mirror the Anthropic assembler) and the complete parsed object.
        out.push({
          type: "tool_use",
          toolUseId: id,
          name,
          inputPartial: JSON.stringify(input),
        });
        out.push({
          type: "tool_use",
          toolUseId: id,
          name,
          inputComplete: input,
        });
      }
    }

    if (candidate?.finishReason) {
      this.stopReason = mapFinishReason(candidate.finishReason, this.sawFunctionCall);
    }

    return out;
  }

  finalize(onEvent: (event: StreamEvent) => void): ChatResponse {
    // A functionCall present always means a tool-use stop, even if Gemini
    // reported finishReason STOP alongside the call.
    if (this.sawFunctionCall) this.stopReason = "tool_use";

    if (!this.usageEmitted) {
      onEvent({
        type: "usage",
        input: this.inputTokens,
        output: this.outputTokens,
        cached: this.cachedReadTokens,
      });
    }
    onEvent({ type: "done", stopReason: this.stopReason });

    const content: ContentBlock[] = this.order.map((b) =>
      b.kind === "text"
        ? { type: "text", text: b.text }
        : { type: "tool_use", id: b.id, name: b.name, input: b.input },
    );

    const usage: TokenUsage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedReadTokens: this.cachedReadTokens,
      cachedWriteTokens: 0,
    };

    return { content, stopReason: this.stopReason, usage };
  }

  private nextToolIndex(name: string): number {
    const n = this.toolCounts.get(name) ?? 0;
    this.toolCounts.set(name, n + 1);
    return n;
  }

  private applyUsage(usage: GeminiUsageMetadata): void {
    if (typeof usage.promptTokenCount === "number") this.inputTokens = usage.promptTokenCount;
    if (typeof usage.candidatesTokenCount === "number") this.outputTokens = usage.candidatesTokenCount;
    if (typeof usage.cachedContentTokenCount === "number") {
      this.cachedReadTokens = usage.cachedContentTokenCount;
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic tool-use id
// ---------------------------------------------------------------------------

/**
 * Gemini does not return an id for a functionCall. We synthesize a deterministic
 * one from the function name + its occurrence index within the turn so that the
 * id is stable and unique, and so a matching normalized tool_result can be
 * correlated by the gateway. The request-side mapping (tool_result →
 * functionResponse) keys on the function NAME (Gemini's only handle), so the
 * synthesized id is purely a gateway-side correlation handle.
 */
function synthToolUseId(name: string, index: number): string {
  return `gemini-${name}-${index}`;
}

// ---------------------------------------------------------------------------
// Stop-reason mapping
// ---------------------------------------------------------------------------

/**
 * Maps Gemini's `finishReason` to the Anthropic-style stop reasons the gateway
 * expects. A present functionCall ALWAYS wins → "tool_use" (Gemini reports
 * finishReason STOP even when it emits a functionCall).
 */
function mapFinishReason(finishReason: string, sawFunctionCall: boolean): string {
  if (sawFunctionCall) return "tool_use";
  switch (finishReason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "STOP":
      return "end_turn";
    // SAFETY, RECITATION, OTHER, BLOCKLIST, etc. → terminal; closest normalized
    // analogue is a non-natural stop. We surface "stop_sequence" so the gateway
    // treats it as a hard end (not a tool round-trip).
    default:
      return "stop_sequence";
  }
}

// ---------------------------------------------------------------------------
// Request mapping (normalized → Gemini)
// ---------------------------------------------------------------------------

function toGeminiRequest(request: ChatRequest): GeminiRequest {
  const body: GeminiRequest = {
    contents: request.messages.map(toGeminiContent),
    generationConfig: { maxOutputTokens: request.maxTokens },
  };

  if (request.system && request.system.length > 0) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }

  if (request.tools.length > 0) {
    body.tools = [
      { functionDeclarations: request.tools.map(toGeminiFunctionDeclaration) },
    ];
  }

  return body;
}

/**
 * Maps a normalized conversation message to a Gemini `Content`.
 *
 * Role mapping: "assistant" → "model"; "user" → "user". There is no Gemini
 * "system" or "tool" role, so:
 *   - a tool_result block (which the normalized shape carries on a USER message)
 *     becomes a `functionResponse` part inside a "user" content;
 *   - a tool_use block (on an ASSISTANT message) becomes a `functionCall` part
 *     inside a "model" content.
 */
function toGeminiContent(msg: ConversationMessage): GeminiContent {
  const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
  return {
    role,
    parts: msg.content.map(toGeminiPart),
  };
}

function toGeminiPart(block: ContentBlock): GeminiPart {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "tool_use": {
      const tu = block as ToolUseBlock;
      return { functionCall: { name: tu.name, args: tu.input } };
    }
    case "tool_result": {
      const tr = block as ToolResultBlock;
      return {
        functionResponse: {
          // Gemini keys a functionResponse by the function NAME, not an id.
          // The normalized tool_result carries only tool_use_id; we recover the
          // name from the synthetic id (`gemini-{name}-{index}`) when present,
          // else fall back to the raw id.
          name: toolNameFromUseId(tr.tool_use_id),
          response: { content: toolResultContentToString(tr.content) },
        },
      };
    }
    default: {
      const never = block as { type: string };
      throw new Error(`Unknown content block type: ${never.type}`);
    }
  }
}

/**
 * Recovers the Gemini function name from a synthesized tool-use id
 * (`gemini-{name}-{index}`). If the id wasn't minted by this adapter (e.g. it
 * came from another provider during a cross-provider session), the whole id is
 * used as the name — best effort.
 */
function toolNameFromUseId(toolUseId: string): string {
  const m = /^gemini-(.+)-\d+$/.exec(toolUseId);
  return m && m[1] ? m[1] : toolUseId;
}

function toolResultContentToString(content: string | { type: "text"; text: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => c.text).join("");
}

function toGeminiFunctionDeclaration(tool: ToolDefinition): GeminiFunctionDeclaration {
  const decl: GeminiFunctionDeclaration = {
    name: tool.name,
    description: tool.description,
  };
  const params = sanitizeSchema(tool.inputSchema);
  if (params !== undefined) decl.parameters = params;
  return decl;
}

/**
 * Gemini's `parameters` is an OpenAPI-3.0 schema SUBSET — it rejects JSON-Schema
 * meta keywords like `$schema` and `additionalProperties`. We deep-clone the
 * normalized JSON schema while stripping those unsupported keys so the schema
 * passes through faithfully otherwise.
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || schema === undefined) return undefined;
  if (Array.isArray(schema) || typeof schema !== "object") return undefined;
  return cleanValue(schema) as Record<string, unknown>;
}

/** JSON-Schema keys Gemini's OpenAPI subset does not accept. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "additionalProperties",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "patternProperties",
]);

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = cleanValue(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Response mapping (Gemini → normalized)
// ---------------------------------------------------------------------------

function fromGeminiResponse(raw: GeminiResponse): ChatResponse {
  const candidate = raw.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const content: ContentBlock[] = [];
  const toolCounts = new Map<string, number>();
  let sawFunctionCall = false;

  for (const part of parts) {
    if (isTextPart(part)) {
      const text = part.text ?? "";
      if (text === "") continue;
      const last = content[content.length - 1];
      if (last && last.type === "text") {
        last.text += text;
      } else {
        content.push({ type: "text", text });
      }
    } else if (isFunctionCallPart(part)) {
      sawFunctionCall = true;
      const name = part.functionCall.name;
      const index = toolCounts.get(name) ?? 0;
      toolCounts.set(name, index + 1);
      content.push({
        type: "tool_use",
        id: synthToolUseId(name, index),
        name,
        input: part.functionCall.args ?? {},
      });
    }
    // functionResponse parts never appear in a model response; ignore others.
  }

  const stopReason = mapFinishReason(candidate?.finishReason ?? "STOP", sawFunctionCall);

  const usage: TokenUsage = {
    inputTokens: raw.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: raw.usageMetadata?.candidatesTokenCount ?? 0,
    cachedReadTokens: raw.usageMetadata?.cachedContentTokenCount ?? 0,
    cachedWriteTokens: 0,
  };

  return { content, stopReason, usage };
}

// ---------------------------------------------------------------------------
// Part type guards
// ---------------------------------------------------------------------------

function isTextPart(part: GeminiPart): part is GeminiTextPart {
  return typeof (part as GeminiTextPart).text === "string";
}

function isFunctionCallPart(part: GeminiPart): part is GeminiFunctionCallPart {
  return (
    typeof (part as GeminiFunctionCallPart).functionCall === "object" &&
    (part as GeminiFunctionCallPart).functionCall !== null
  );
}

// ---------------------------------------------------------------------------
// Managed-mode factory (mirrors createManagedAnthropicProvider)
// ---------------------------------------------------------------------------

/**
 * Constructs a GeminiChatProvider for MANAGED billing mode, reading the platform
 * Gemini API key from `GEMINI_API_KEY` (falling back to `GOOGLE_API_KEY`).
 * Throws a clear, inert error at composition time if neither is set — the
 * gateway never attempts an unauthenticated provider call. BYO mode injects the
 * caller's key directly and does not use this factory.
 */
export function createManagedGeminiProvider(options?: {
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  model?: string;
}): GeminiChatProvider {
  const env = options?.env ?? process.env;
  const apiKey = env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "GEMINI_API_KEY (or GOOGLE_API_KEY) is required for managed inference mode but is not set. " +
        "Provision the platform Gemini API key to enable managed (credit-billed) turns. " +
        "BYO mode does not require this.",
    );
  }
  return new GeminiChatProvider({
    apiKey,
    baseUrl: options?.baseUrl,
    model: options?.model,
  });
}
