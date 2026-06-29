/**
 * Streaming turn / tool-loop state machine — the "remote brain, local hands"
 * protocol for Tier-3 kit inference.
 *
 * This is the streaming, multi-round-trip counterpart of `runManagedTurn`. It
 * drives a single logical TURN that may span several provider round-trips:
 *
 *   client → user input
 *      │
 *      ▼
 *   ┌─ runStreamingTurn ──────────────────────────────────────────────┐
 *   │  load session (history + injected system-prompt ref + billing)   │
 *   │  reserve ONE credit hold for the whole turn (managed mode)        │
 *   │  ┌─ provider round-trip ─────────────────────────────────────┐   │
 *   │  │  stream provider; emit text / tool_use / usage to client   │   │
 *   │  │  accumulate usage; append assistant message to history     │   │
 *   │  └────────────────────────────────────────────────────────────┘  │
 *   │  if stop_reason === "tool_use":                                   │
 *   │     PAUSE — persist turnState "awaiting_tool_results"             │
 *   │            (hold + accumulated usage + pending tool blocks),      │
 *   │     emit `done` (stopReason "tool_use"), RETURN control.          │
 *   │  else (natural stop):                                            │
 *   │     settle the hold with the SUMMED usage (× markup), turn idle.  │
 *   └──────────────────────────────────────────────────────────────────┘
 *      │ (the client executes the tool calls locally — "local hands")
 *      ▼
 *   resumeWithToolResults → append tool_result messages → loop continues
 *      under the SAME hold until a natural stop, then settle.
 *
 * SECURITY (Tier-3 invariant): the injected system prompt is resolved server-
 * side from `systemPromptRef` and placed in the ChatRequest, but it is NEVER
 * emitted to the client. Only `text`, `tool_use`, `usage`, `done`, and `error`
 * StreamEvents cross the boundary — and none of those carry the system prompt
 * or the full history. The caller (router/host) forwards exactly those events.
 *
 * BILLING: a single hold backs the whole turn. Usage is accumulated across
 * every round-trip and settled once, on natural stop. On any provider/stream
 * error the hold is released (the buyer is not charged). In BYO mode the ledger
 * is never touched (no hold, no settle).
 */

import type {
  ChatProvider,
  CreditLedgerRepository,
  SessionStore,
  StreamEvent,
} from "../ports.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ConversationMessage,
  GatewaySession,
  TextBlock,
  TokenUsage,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  TurnState,
} from "../types.js";
import { computeDebitCents, computeMaxHoldCents } from "../pricing.js";
import { DEFAULT_MARKUP_BPS } from "../config.js";
import { InsufficientCreditsError } from "./managed-turn.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a session id cannot be resolved (missing or expired). */
export class SessionNotFoundError extends Error {
  readonly name = "SessionNotFoundError";
  constructor(public readonly sessionId: string) {
    super(`Gateway session not found or expired: ${sessionId}`);
  }
}

/**
 * Thrown when an operation is attempted in the wrong turn state — e.g. calling
 * `resumeWithToolResults` on a session that is not awaiting tool results, or
 * starting a new turn while one is still paused.
 */
export class InvalidTurnStateError extends Error {
  readonly name = "InvalidTurnStateError";
  constructor(
    public readonly sessionId: string,
    public readonly expected: TurnState["status"],
    public readonly actual: TurnState["status"],
  ) {
    super(
      `Session ${sessionId} is in turn state "${actual}"; expected "${expected}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// Deps / inputs
// ---------------------------------------------------------------------------

export interface StreamingTurnDeps {
  /** Chat provider configured with the managed (or per-call BYO) key. */
  chatProvider: ChatProvider;
  /** Session store (DynamoDB or Postgres). */
  sessions: SessionStore;
  /** Credit ledger. Only consulted in managed mode. */
  ledger: CreditLedgerRepository;
  /**
   * Resolves the secret system prompt for a session from its `systemPromptRef`.
   * Runs SERVER-SIDE only; the resolved text is placed in the ChatRequest and
   * never emitted to the client. Injected at the composition root (reads the
   * kit package from object storage in hosted mode).
   */
  resolveSystemPrompt: (session: GatewaySession) => Promise<string>;
  /**
   * The tools the kit declares (passed to the provider each round-trip).
   * Resolved server-side from the kit; defaults to none.
   */
  resolveTools?: (session: GatewaySession) => Promise<ToolDefinition[]>;
  /** Clock — ISO 8601 timestamp. Injected for deterministic tests. */
  now: () => string;
  /** The model to use. Resolved from the session/kit; falls back to this. */
  model: string;
  /** Max output tokens per provider round-trip. */
  maxTokens: number;
  /** Markup in basis points. Defaults to DEFAULT_MARKUP_BPS (0 = at cost). */
  markupBps?: number;
  /**
   * Worst-case number of provider round-trips a single turn may take, used to
   * size the conservative per-turn hold. Default 8. The hold is a ceiling; the
   * buyer is settled the ACTUAL summed usage, so a generous value only affects
   * how much balance is reserved mid-turn, never what is charged.
   */
  maxToolRoundTrips?: number;
  /**
   * Approximate prompt-token count used to size the hold. The caller may
   * estimate from system + history; defaults to a char/4 heuristic over the
   * assembled request.
   */
  estimateInputTokens?: (request: ChatRequest) => number;
}

export interface StreamingTurnInput {
  /** The user's text input for this turn. */
  userInput: string;
}

/** A single tool result returned by the client ("local hands"). */
export interface ToolResultInput {
  toolUseId: string;
  /** Success result content (string or text blocks). Mutually exclusive with `error`. */
  result?: string | TextBlock[];
  /** Error message if the local tool execution failed. */
  error?: string;
}

/** Outcome of a streaming turn / resume call. */
export interface StreamingTurnResult {
  /** Terminal status: "completed" (natural stop) or "awaiting_tool_results" (paused). */
  status: "completed" | "awaiting_tool_results";
  /** The model's stop reason for the last round-trip. */
  stopReason: string;
  /** Tool calls the client must execute (present iff status awaiting_tool_results). */
  pendingToolUse: ToolUseBlock[];
  /** Usage accumulated across the whole turn so far. */
  usage: TokenUsage;
  /**
   * Amount debited this turn, in US cents. Only set when the turn completes and
   * billing is managed. 0 in BYO mode or while paused.
   */
  debitedCents: number;
  /** Available balance after settlement (managed + completed); undefined otherwise. */
  balanceCents?: number;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Starts a new turn for an existing session: appends the user input, opens a
 * credit hold (managed), and runs the provider tool-loop until the model either
 * stops naturally (settle) or requests tools (pause).
 */
export async function runStreamingTurn(
  deps: StreamingTurnDeps,
  sessionId: string,
  input: StreamingTurnInput,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamingTurnResult> {
  const session = await loadSession(deps, sessionId);

  const current = session.turnState ?? idleTurnState();
  if (current.status !== "idle") {
    throw new InvalidTurnStateError(sessionId, "idle", current.status);
  }

  // Append the user turn to history.
  const userMessage: ConversationMessage = {
    role: "user",
    content: [{ type: "text", text: input.userInput }],
  };
  await deps.sessions.appendMessages({
    sessionId,
    messages: [userMessage],
    updatedAt: deps.now(),
  });

  // Open the turn: reserve a single hold sized for the worst-case turn.
  const managed = session.billingMode === "managed";
  let holdId: string | null = null;
  if (managed) {
    holdId = await openTurnHold(deps, session);
  }

  const turnState: TurnState = {
    status: "idle",
    holdId,
    accumulatedUsage: zeroUsage(),
    pendingToolUse: [],
    turnRef: sessionId,
  };

  return runLoop(deps, sessionId, turnState, onEvent);
}

/**
 * Resumes a paused turn: appends the client's tool results as a user turn and
 * continues the provider loop under the SAME hold. Requires the session to be
 * in "awaiting_tool_results".
 */
export async function resumeWithToolResults(
  deps: StreamingTurnDeps,
  sessionId: string,
  results: ToolResultInput[],
  onEvent: (event: StreamEvent) => void,
): Promise<StreamingTurnResult> {
  const session = await loadSession(deps, sessionId);
  const current = session.turnState;
  if (!current || current.status !== "awaiting_tool_results") {
    throw new InvalidTurnStateError(
      sessionId,
      "awaiting_tool_results",
      current?.status ?? "idle",
    );
  }

  // Append the tool_result blocks as a single user turn.
  const toolResultBlocks: ContentBlock[] = results.map(toToolResultBlock);
  await deps.sessions.appendMessages({
    sessionId,
    messages: [{ role: "user", content: toolResultBlocks }],
    updatedAt: deps.now(),
  });

  // Continue under the same hold + accumulated usage; clear pending tools.
  const turnState: TurnState = {
    status: "idle",
    holdId: current.holdId,
    accumulatedUsage: current.accumulatedUsage,
    pendingToolUse: [],
    turnRef: current.turnRef,
  };

  return runLoop(deps, sessionId, turnState, onEvent);
}

// ---------------------------------------------------------------------------
// Core loop (shared by start + resume)
// ---------------------------------------------------------------------------

/**
 * Runs one provider round-trip for the current turn. Re-loads the session to
 * get the latest history (the caller has already appended the user/tool_result
 * turn), assembles the ChatRequest with the SERVER-SIDE system prompt, streams,
 * accumulates usage, and either pauses (tool_use) or settles (natural stop).
 */
async function runLoop(
  deps: StreamingTurnDeps,
  sessionId: string,
  turnState: TurnState,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamingTurnResult> {
  const markupBps = deps.markupBps ?? DEFAULT_MARKUP_BPS;
  const managed = turnState.holdId !== null;

  // Re-load to get the latest appended history.
  const session = await loadSession(deps, sessionId);

  // Assemble the provider request. The system prompt is resolved server-side
  // and lives ONLY in this request object — it is never emitted to onEvent.
  const system = await deps.resolveSystemPrompt(session);
  const tools = deps.resolveTools ? await deps.resolveTools(session) : [];
  const request: ChatRequest = {
    model: deps.model,
    system,
    messages: session.messages,
    tools,
    maxTokens: deps.maxTokens,
  };

  // Stream the provider. Forward ONLY normalized events; the system prompt and
  // history never cross this callback.
  let response: ChatResponse;
  try {
    response = await deps.chatProvider.streamMessage(request, onEvent);
  } catch (providerError) {
    // Stream failed → release the whole turn's hold (buyer not charged).
    if (managed && turnState.holdId) {
      await deps.ledger.releaseHold(turnState.holdId, deps.now()).catch(() => undefined);
    }
    // `error` was already emitted by the provider adapter; mark turn idle.
    await persistTurnState(deps, sessionId, idleTurnState());
    throw providerError;
  }

  // Persist the assistant's response as a message in history.
  const assistantMessage: ConversationMessage = {
    role: "assistant",
    content: response.content,
  };
  await deps.sessions.appendMessages({
    sessionId,
    messages: [assistantMessage],
    updatedAt: deps.now(),
  });

  // Accumulate usage across the turn.
  const accumulatedUsage = addUsage(turnState.accumulatedUsage, response.usage);

  const pendingToolUse = response.content.filter(
    (b): b is ToolUseBlock => b.type === "tool_use",
  );
  const isToolPause = response.stopReason === "tool_use" && pendingToolUse.length > 0;

  if (isToolPause) {
    // PAUSE: persist "awaiting_tool_results" and return control to the client.
    await persistTurnState(deps, sessionId, {
      status: "awaiting_tool_results",
      holdId: turnState.holdId,
      accumulatedUsage,
      pendingToolUse,
      turnRef: turnState.turnRef,
    });

    return {
      status: "awaiting_tool_results",
      stopReason: response.stopReason,
      pendingToolUse,
      usage: accumulatedUsage,
      debitedCents: 0,
    };
  }

  // NATURAL STOP: settle the single hold with the SUMMED usage, turn → idle.
  let debitedCents = 0;
  let balanceCents: number | undefined;
  if (managed && turnState.holdId) {
    debitedCents = computeDebitCents(accumulatedUsage, deps.model, markupBps);
    const account = await deps.ledger.settleHold(
      turnState.holdId,
      debitedCents,
      deps.now(),
      turnState.turnRef,
    );
    balanceCents = account.availableBalanceCents;
  }

  await persistTurnState(deps, sessionId, idleTurnState());

  return {
    status: "completed",
    stopReason: response.stopReason,
    pendingToolUse: [],
    usage: accumulatedUsage,
    debitedCents,
    balanceCents,
  };
}

// ---------------------------------------------------------------------------
// Hold sizing
// ---------------------------------------------------------------------------

/**
 * Reserves one hold for the whole turn. Sized conservatively for up to
 * `maxToolRoundTrips` round-trips of `maxTokens` output (a ceiling). On
 * insufficient balance throws InsufficientCreditsError BEFORE any provider call.
 */
async function openTurnHold(
  deps: StreamingTurnDeps,
  session: GatewaySession,
): Promise<string> {
  const markupBps = deps.markupBps ?? DEFAULT_MARKUP_BPS;
  const roundTrips = Math.max(1, deps.maxToolRoundTrips ?? 8);

  // Estimate input tokens for sizing. Without a request yet, estimate from the
  // current history; the caller can override via estimateInputTokens.
  const provisional: ChatRequest = {
    model: deps.model,
    system: "",
    messages: session.messages,
    tools: [],
    maxTokens: deps.maxTokens,
  };
  const estInput = deps.estimateInputTokens
    ? deps.estimateInputTokens(provisional)
    : defaultEstimateInputTokens(provisional);

  const perRoundTrip = computeMaxHoldCents(
    estInput,
    deps.maxTokens,
    deps.model,
    markupBps,
  );
  const maxHoldCents = perRoundTrip * roundTrips;

  await deps.ledger.ensureAccount(session.userId, deps.now());
  try {
    return await deps.ledger.reserveHold(session.userId, maxHoldCents, deps.now());
  } catch {
    const account = await deps.ledger.getAccount(session.userId).catch(() => undefined);
    throw new InsufficientCreditsError(
      session.userId,
      maxHoldCents,
      account?.availableBalanceCents,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadSession(
  deps: StreamingTurnDeps,
  sessionId: string,
): Promise<GatewaySession> {
  const session = await deps.sessions.getSession(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  return session;
}

async function persistTurnState(
  deps: StreamingTurnDeps,
  sessionId: string,
  turnState: TurnState,
): Promise<void> {
  await deps.sessions.setTurnState(sessionId, turnState, deps.now());
}

function idleTurnState(): TurnState {
  return {
    status: "idle",
    holdId: null,
    accumulatedUsage: zeroUsage(),
    pendingToolUse: [],
  };
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cachedWriteTokens: a.cachedWriteTokens + b.cachedWriteTokens,
  };
}

function toToolResultBlock(input: ToolResultInput): ToolResultBlock {
  if (input.error !== undefined) {
    return {
      type: "tool_result",
      tool_use_id: input.toolUseId,
      content: input.error,
    };
  }
  return {
    type: "tool_result",
    tool_use_id: input.toolUseId,
    content: input.result ?? "",
  };
}

/** Char/4 heuristic over the assembled request messages (system excluded here). */
function defaultEstimateInputTokens(request: ChatRequest): number {
  let chars = request.system.length;
  for (const msg of request.messages) {
    for (const block of msg.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool_use") chars += JSON.stringify(block.input).length;
      else if (block.type === "tool_result") {
        chars +=
          typeof block.content === "string"
            ? block.content.length
            : block.content.reduce((n, c) => n + c.text.length, 0);
      }
    }
  }
  return Math.ceil(chars / 4);
}
