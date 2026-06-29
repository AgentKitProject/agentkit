/**
 * Core domain types for the AgentKit inference gateway.
 *
 * Design decisions baked in:
 *
 * CREDITS:
 *   - NON-REFUNDABLE and NEVER EXPIRE. Credits are not a regulated financial
 *     instrument; users buy compute time. The `refund` transaction type exists
 *     solely for support-team manual adjustments (e.g. correcting a billing
 *     error). There is no expiry column, no expiry TTL, no expiry sweeper.
 *   - MANAGED billing mode: prepaid only. The system does a hard stop at zero
 *     balance — we NEVER extend credit or charge-after-the-fact.
 *   - BYO billing mode: the caller supplies their own provider API key. The
 *     credit ledger is untouched for BYO calls.
 *   - Self-host MAY optionally run in managed mode (operator supplies a Stripe
 *     integration + provider API key). Billing is wireable, not hardcoded-off.
 *
 * MARKUP:
 *   - Default 0 (DEFAULT_MARKUP_BPS = 0 basis points): managed inference passes
 *     through at cost. A deployment that wants a token margin sets MARKUP_BPS
 *     server-side (env-overridable per deployment).
 *
 * SESSION:
 *   - Gateway sessions hold the injected system-prompt reference and
 *     conversation history server-side so the kit text never reaches clients.
 *   - Sessions have a TTL (default 4 hours). Stale sessions are cleaned by
 *     DynamoDB TTL or a Postgres sweep.
 *
 * PROVIDERS:
 *   - Anthropic-first. The ChatProvider port is intentionally shaped so
 *     OpenAI-compatible and Gemini providers can be wired later without
 *     breaking the port contract.
 */

// ---------------------------------------------------------------------------
// Billing mode
// ---------------------------------------------------------------------------

/**
 * 'managed'  — our provider API key is used server-side; cost is charged
 *              against the buyer's prepaid credit balance.
 * 'byo'      — caller supplies their own provider API key via the session
 *              config; the ledger is NOT touched.
 */
export type BillingMode = "managed" | "byo";

// ---------------------------------------------------------------------------
// Provider / model types (extend as new providers are wired)
// ---------------------------------------------------------------------------

/**
 * Canonical provider identifiers. Mirrors the AiProviderType concept used in
 * @agentkitforge/core. Extensible: OpenAI / Gemini / ollama fit without port changes.
 */
export type AiProviderType = "anthropic" | "openai" | "openai-compatible" | "gemini" | "ollama";

/** Per-call token usage reported by the provider. */
export interface TokenUsage {
  /** Tokens in the user input + injected system prompt. */
  inputTokens: number;
  /** Tokens in the model response. */
  outputTokens: number;
  /**
   * Prompt-cache read tokens (Anthropic cache_read_input_tokens).
   * Priced at the discounted cached-read rate. 0 when not applicable.
   */
  cachedReadTokens: number;
  /**
   * Prompt-cache write tokens (Anthropic cache_creation_input_tokens).
   * Priced at the full input rate (or higher for cache-write premium).
   * 0 when not applicable.
   */
  cachedWriteTokens: number;
}

/** A single message in the conversation history. */
export interface ConversationMessage {
  role: "user" | "assistant";
  /** Content blocks matching the Anthropic Messages API content array shape. */
  content: ContentBlock[];
}

/** A text content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A tool-use block emitted by the model. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool-result block submitted by the client. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | TextBlock[];
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Chat provider request/response
// ---------------------------------------------------------------------------

/** A tool definition passed to the provider. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

/** The request shape sent to a ChatProvider. */
export interface ChatRequest {
  /** The model identifier (e.g. "claude-opus-4-5", "gpt-4o"). */
  model: string;
  /** Server-injected system prompt (the secret kit instructions). */
  system: string;
  /** Conversation history including the current user turn. */
  messages: ConversationMessage[];
  /** Tools the model may call; empty if the kit declares none. */
  tools: ToolDefinition[];
  /** Maximum tokens to generate. */
  maxTokens: number;
}

/** The response from a non-streaming ChatProvider call. */
export interface ChatResponse {
  /** The model's response content blocks (text + tool_use). */
  content: ContentBlock[];
  /**
   * Stop reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'.
   * Matches Anthropic's stop_reason strings.
   */
  stopReason: string;
  /** Token usage for this call as reported by the provider. */
  usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Gateway session
// ---------------------------------------------------------------------------

/**
 * Persisted state of the in-flight turn for a session.
 *
 * A single logical "turn" may span several provider round-trips: when the model
 * emits tool_use, the gateway PAUSES (status "awaiting_tool_results"), streams
 * the tool calls to the client, and resumes when the client returns results via
 * the tool-result route. The same credit hold and accumulated usage span the
 * whole turn; only on the turn's natural stop is the hold settled with the
 * summed usage.
 *
 * `idle` means there is no in-flight turn (the next user input opens one).
 */
export interface TurnState {
  status: "idle" | "awaiting_tool_results";
  /**
   * The open credit hold backing the in-flight turn (managed mode only).
   * Carried across pause/resume so the loop settles a single hold once the
   * turn naturally stops. Null in BYO mode or when idle.
   */
  holdId: string | null;
  /**
   * Usage accumulated across every provider round-trip in the current turn.
   * Settled against the hold (with markup) when the turn naturally stops.
   */
  accumulatedUsage: TokenUsage;
  /**
   * The tool_use blocks the client must execute and return results for.
   * Present only while status === "awaiting_tool_results".
   */
  pendingToolUse: ToolUseBlock[];
  /** Optional trace ref threaded into ledger transactions for this turn. */
  turnRef?: string;
}

/** A gateway session ties a buyer to a kit run, billing mode, and conversation. */
export interface GatewaySession {
  /** Opaque session identifier. */
  sessionId: string;
  /** The buyer / authenticated user. */
  userId: string;
  /** The kit being run. Used for entitlement checks + system-prompt injection. */
  kitId: string;
  /** Slug for display / logging. Denormalised from the kit record at session create. */
  kitSlug: string;
  /**
   * Reference key for the injected system prompt.
   * In managed mode this is the kit's S3/object-store package key (the gateway
   * reads AGENTKIT.md + START_HERE.md server-side and never sends content to the
   * client).
   * In BYO mode the caller may supply their own system-prompt key or raw text.
   */
  systemPromptRef: string;
  billingMode: BillingMode;
  /** Provider / model config for this session. Only set in BYO mode; null in managed. */
  byoProviderConfig: ByoProviderConfig | null;
  /** Conversation history (append-only in the store). */
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
  /**
   * Unix epoch seconds for store TTL sweepers.
   * Default: createdAt + SESSION_TTL_SECONDS (4 hours).
   */
  expiresAt: number;
  /**
   * In-flight turn state (credit hold, accumulated usage, pending tool calls).
   * Absent on legacy sessions → treated as an idle turn.
   */
  turnState?: TurnState;
}

/** Caller-supplied provider config for BYO mode. Never persisted in plaintext;
 *  the API key is ephemeral (validated per-call, not stored in the session).
 *  The session record stores providerType + model only. */
export interface ByoProviderConfig {
  providerType: AiProviderType;
  /** Provider base URL (e.g. "https://api.anthropic.com/v1"). */
  baseUrl: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Credit ledger
// ---------------------------------------------------------------------------

/** A buyer's credit balance (prepaid). */
export interface CreditAccount {
  userId: string;
  /**
   * Available balance in US cents (integer). This is the balance MINUS any
   * outstanding holds. Always >= 0 (the system enforces this at reserve time).
   */
  availableBalanceCents: number;
  /**
   * Held (reserved) balance in US cents (integer). Funds reserved by open holds
   * but not yet settled or released. Informational — not deducted from
   * availableBalanceCents until the hold is settled.
   */
  heldBalanceCents: number;
  /**
   * Total lifetime credits purchased (topups only; never decremented).
   * Used for support visibility, not billing math.
   */
  lifetimeTopupCents: number;
  updatedAt: string;
}

/** Credit transaction types. */
export type CreditTransactionType =
  /** Buyer purchased credits (Stripe or admin grant). */
  | "topup"
  /** A model call was debited against the balance (post-settle). */
  | "debit"
  /**
   * Support-team manual credit adjustment. Credits are NON-REFUNDABLE and
   * NEVER EXPIRE; this type exists solely for error correction by support
   * staff. Never triggered automatically.
   */
  | "refund"
  /** One-off operator balance correction. */
  | "adjustment"
  /** Funds reserved for a pending model call (creates a Hold). */
  | "hold"
  /** Funds released back to available balance (hold cancelled or overshoot). */
  | "hold_release";

/** An append-only credit transaction record. Never updated; never deleted. */
export interface CreditTransaction {
  /** Opaque unique transaction identifier. */
  transactionId: string;
  userId: string;
  type: CreditTransactionType;
  /**
   * Positive integer (US cents). Always positive regardless of direction;
   * the `type` field indicates whether this decrements or increments the balance.
   */
  amountCents: number;
  /**
   * ISO 8601 timestamp of the transaction. Supplied by the caller
   * (never Date.now() inside the repository). Lexicographically sortable.
   */
  createdAt: string;
  /** Optional reference to a holdId (for debit/hold_release that settle a hold). */
  holdId?: string;
  /** Free-form description for support tooling. */
  description?: string;
  /**
   * Source identifier for topups (e.g. Stripe payment-intent id) or debit
   * (e.g. gateway turn id / sessionId) for traceability.
   */
  sourceRef?: string;
}

/** An open balance hold (reservation) for a pending model call. */
export interface CreditHold {
  /** Opaque unique hold identifier. */
  holdId: string;
  userId: string;
  /** Maximum cost reserved in US cents. */
  reservedCents: number;
  /** Actual settled cost in US cents (set when the hold is settled). */
  settledCents?: number;
  status: "open" | "settled" | "released";
  createdAt: string;
  settledAt?: string;
}

// ---------------------------------------------------------------------------
// Input types for ledger port methods
// ---------------------------------------------------------------------------

export interface RecordTransactionInput {
  userId: string;
  type: CreditTransactionType;
  amountCents: number;
  createdAt: string;
  holdId?: string;
  description?: string;
  sourceRef?: string;
}

export interface CreateSessionInput {
  userId: string;
  kitId: string;
  kitSlug: string;
  systemPromptRef: string;
  billingMode: BillingMode;
  byoProviderConfig: ByoProviderConfig | null;
  createdAt: string;
  /** TTL epoch seconds. */
  expiresAt: number;
}

export interface AppendSessionMessagesInput {
  sessionId: string;
  messages: ConversationMessage[];
  updatedAt: string;
}
