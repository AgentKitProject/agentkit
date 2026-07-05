/**
 * Ports: the runtime- and cloud-agnostic interfaces the gateway core depends on.
 *
 * Each port has two adapters (see ../adapters):
 *   - aws/      → DynamoDB                    (hosted deployment, Lambda)
 *   - selfhost/ → Postgres                    (self-hosted, container on k8s)
 *
 * The core/services layer MUST depend ONLY on these ports — never on a concrete
 * adapter, cloud SDK, or provider SDK directly. That is what keeps the domain
 * logic identical across hosted and self-hosted runtimes.
 *
 * ChatProvider is the single exception: it is an *outbound* port (a dependency
 * on an external AI provider). The Anthropic adapter implements it first;
 * OpenAI and Gemini fit the same shape later.
 */

import type {
  AccrueRoyaltyInput,
  AppendSessionMessagesInput,
  ChatRequest,
  ChatResponse,
  ConversationMessage,
  CreateSessionInput,
  CreditAccount,
  CreditHold,
  CreditTransaction,
  GatewaySession,
  PendingSellerEarnings,
  RecordTransactionInput,
  TurnState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Application configuration + secrets, sourced per runtime (env, k8s Secret, AWS SSM/Secrets Manager). */
export interface ConfigProvider {
  /** Returns a config value; throws if `required` and missing. */
  get(key: string, required?: boolean): string | undefined;
}

// ---------------------------------------------------------------------------
// Chat provider (outbound port)
// ---------------------------------------------------------------------------

/**
 * Outbound port for AI provider calls. The core never imports an AI SDK
 * directly — it calls a ChatProvider injected at the composition root.
 *
 * Anthropic-first design: the interface mirrors the Anthropic Messages API
 * shape (system, messages, tools, content blocks) because that is the most
 * expressive common denominator. OpenAI / Gemini adapters can map to this
 * shape without loss.
 *
 * Phase 0: `sendMessage` (non-streaming) is fully implemented.
 *          `streamMessage` is scaffolded/stubbed — streaming will be wired in
 *          Phase 1 once the session turn route is built.
 */
export interface ChatProvider {
  readonly providerType: string;

  /**
   * Sends a non-streaming chat request and returns the full response.
   * Used for Phase 0 contract tests and synchronous turn handling.
   */
  sendMessage(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Sends a streaming chat request and emits normalized provider events to
   * `onEvent` as they arrive. Resolves with the fully-assembled ChatResponse
   * (content blocks incl. tool_use + total usage) once the stream completes.
   *
   * The normalized event stream is provider-agnostic — the Anthropic adapter
   * parses the Messages SSE event stream and maps it to these events; an
   * OpenAI/Gemini adapter would map their own stream shapes to the same set.
   * Tool-use input is accumulated from the provider's partial-JSON deltas and
   * surfaced both incrementally (`inputPartial`) and once complete
   * (`inputComplete`).
   */
  streamMessage(
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse>;
}

/**
 * Normalized, provider-agnostic streaming events emitted by `streamMessage`.
 *
 * These are the ONLY shapes that may cross the gateway→client boundary. In
 * particular there is no event carrying the injected system prompt or the
 * full conversation history — only text, tool-call requests, usage, and
 * terminal signals leave the server (see the gateway router/service).
 */
export type StreamEvent =
  /** An incremental chunk of assistant text. */
  | { type: "text"; delta: string }
  /**
   * A tool-use block from the model.
   *   - `inputPartial`  — an incremental fragment of the tool input JSON
   *     (accumulated from the provider's partial-JSON deltas). Present on
   *     in-progress events.
   *   - `inputComplete` — the fully-parsed input object, present on the
   *     final tool_use event for that block (when the block stops).
   * Exactly one of `inputPartial` / `inputComplete` is set per event.
   */
  | {
      type: "tool_use";
      toolUseId: string;
      name: string;
      inputPartial?: string;
      inputComplete?: Record<string, unknown>;
    }
  /** Token usage as reported by the provider (cumulative for the call). */
  | { type: "usage"; input: number; output: number; cached: number }
  /** The model stopped. `stopReason` mirrors Anthropic's stop_reason. */
  | { type: "done"; stopReason: string }
  /** A provider/transport error occurred mid-stream. */
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Credit ledger port (inbound/storage)
// ---------------------------------------------------------------------------

/**
 * Credit ledger — manages prepaid credit balances, append-only transactions,
 * and two-phase holds.
 *
 * INVARIANTS enforced by BOTH adapters:
 *   1. availableBalanceCents >= 0 at all times (atomic decrement fails if it
 *      would go negative).
 *   2. Transactions are append-only; never updated or deleted.
 *   3. Holds are settled or released exactly once.
 *
 * NEVER-EXPIRE policy: there is no expiresAt column on CreditAccount or
 * CreditTransaction. Credits do not expire — do not add expiry logic.
 *
 * NON-REFUNDABLE policy: the `refund` transaction type is for support-team
 * manual error correction only, never triggered automatically.
 *
 * BYO mode: when billingMode === 'byo' the gateway does NOT call the ledger;
 * the caller is responsible for ensuring this gate.
 */
export interface CreditLedgerRepository {
  /**
   * Returns the credit account for a user, or undefined if the user has never
   * purchased credits.
   */
  getAccount(userId: string): Promise<CreditAccount | undefined>;

  /**
   * Ensures a CreditAccount row exists for the user, returning it. Idempotent.
   * Called lazily when the user first tops up or when we need to gate a call.
   */
  ensureAccount(userId: string, now: string): Promise<CreditAccount>;

  /**
   * Appends a credit transaction record. Does NOT update the account balance —
   * balance is managed atomically by `topup`, `debit`, and hold methods.
   * This is the raw append used for audit and by higher-level methods.
   */
  recordTransaction(input: RecordTransactionInput): Promise<CreditTransaction>;

  /**
   * Tops up the user's balance: atomically increments availableBalanceCents +
   * lifetimeTopupCents, then appends a 'topup' transaction.
   * Returns the updated account.
   */
  topup(userId: string, amountCents: number, now: string, sourceRef?: string): Promise<CreditAccount>;

  /**
   * Directly debits the user's balance (without a prior hold). Used for
   * post-settle simple flows or operator adjustments. Fails if the balance
   * would go negative. Appends a 'debit' transaction.
   * Returns the updated account.
   */
  debit(userId: string, amountCents: number, now: string, description?: string, sourceRef?: string): Promise<CreditAccount>;

  /**
   * Reserves up to `maxCostCents` from the user's available balance.
   * Atomically decrements availableBalanceCents and increments heldBalanceCents.
   * Fails with a known error type if the balance is insufficient.
   * Appends a 'hold' transaction and creates a CreditHold record.
   * Returns the holdId. Callers must call settleHold or releaseHold.
   */
  reserveHold(userId: string, maxCostCents: number, now: string): Promise<string>;

  /**
   * Settles a hold with the actual cost (actualCostCents <= reservedCents).
   * - Appends a 'debit' transaction for actualCostCents.
   * - If actualCostCents < reservedCents, atomically credits back the overshoot
   *   to availableBalanceCents, decrements heldBalanceCents, and appends a
   *   'hold_release' transaction for the difference.
   * - Marks the hold as settled.
   * Returns the updated account.
   */
  settleHold(holdId: string, actualCostCents: number, now: string, sourceRef?: string): Promise<CreditAccount>;

  /**
   * Releases an open hold back to the available balance without charging.
   * Used when a model call fails before completion. Atomically returns
   * reservedCents to availableBalanceCents, decrements heldBalanceCents, marks
   * the hold as released, and appends a 'hold_release' transaction.
   * Returns the updated account.
   */
  releaseHold(holdId: string, now: string): Promise<CreditAccount>;

  /**
   * Returns a single hold by id, or undefined.
   */
  getHold(holdId: string): Promise<CreditHold | undefined>;

  /**
   * Returns transaction history for a user, newest-first.
   */
  listTransactions(userId: string, limit?: number): Promise<CreditTransaction[]>;

  // -------------------------------------------------------------------------
  // Auto v2 free active-minute allowance (per user, ONE-TIME lifetime trial)
  // -------------------------------------------------------------------------
  //
  // Auto v2 gives every user a ONE-TIME free trial of active-minutes (no
  // monthly reset — 2026-07-03 maintainer decision). While any trial minutes
  // remain, the run-driver ALSO waives the invocation fee and shrinks its
  // up-front hold, so a $0-balance user can genuinely consume the trial. The
  // ledger is the per-user billing authority, so the trial counter lives here
  // next to the balance. The key is (userId, periodKey); the trial uses the
  // FIXED lifetime key FREE_TRIAL_PERIOD_KEY ("trial") — the parameter is
  // still named `yearMonth` for wire compatibility with existing adapters.

  /**
   * Returns the active-minutes already consumed from this user's free allowance
   * under the given `yearMonth` key. The free trial passes the FIXED lifetime key
   * FREE_TRIAL_PERIOD_KEY ("trial"), so it never resets. Returns 0 when no usage
   * has been recorded. Read-only —
   * used for observability/tests and pre-checks; the authoritative depletion is
   * `consumeFreeActiveMinutes` (which reads + writes atomically + idempotently).
   */
  getFreeMinutesUsed(userId: string, yearMonth: string): Promise<number>;

  /**
   * Atomically applies a run's active-minutes against the user's free allowance
   * (keyed by `yearMonth`; the free trial passes the FIXED lifetime FREE_TRIAL_PERIOD_KEY)
   * and returns how many of those minutes are BILLABLE (i.e. fall outside the
   * remaining free allowance).
   *
   *   freeRemaining   = max(0, freeAllowance - usedSoFar)
   *   billableMinutes = max(0, runActiveMinutes - freeRemaining)
   *
   * then it INCREMENTS that period's usage by `runActiveMinutes` (so the allowance
   * depletes across runs; with the lifetime trial key it depletes once, ever).
   *
   * IDEMPOTENT per `runId`: a re-settled / retried run for the same `runId` must
   * NOT double-deplete the allowance NOR change the billable result — the first
   * application for a `runId` is recorded and every later call with the same
   * `runId` returns the SAME `billableMinutes` it returned the first time,
   * writing nothing further. This makes the active-minute charge derived from it
   * idempotent alongside the (separately idempotent) hold settle.
   *
   * @param userId            the user.
   * @param yearMonth         period key; the free trial passes FREE_TRIAL_PERIOD_KEY
   *                          (a fixed lifetime key — no monthly reset), not a real month.
   * @param runActiveMinutes  whole active-minutes this run consumed (already
   *                          ceil'd by the caller); MUST be a non-negative integer.
   * @param freeAllowance     the free-minute allowance (e.g. 60). 0 →
   *                          no free tier (every minute billable; still tracked
   *                          idempotently per runId).
   * @param runId             idempotency key (the run's id).
   * @returns the number of BILLABLE active-minutes for this run.
   */
  consumeFreeActiveMinutes(
    userId: string,
    yearMonth: string,
    runActiveMinutes: number,
    freeAllowance: number,
    runId: string,
  ): Promise<number>;

  // -------------------------------------------------------------------------
  // Seller-earnings ledger (premium / per-invocation kit royalties)
  // -------------------------------------------------------------------------
  //
  // A payee-accrual concept alongside the buyer credit ledger. When a PREMIUM
  // (per-invocation) kit run settles as billable, the seller-set per-run royalty
  // is accrued to the SELLING org's earnings, net of the platform commission. A
  // P2 payout job reads the pending balances and marks transfers. All three
  // methods are inert when the royalty is 0 — the premium path only calls them
  // for premium kits.

  /**
   * Accrues a run's gross royalty to `orgId`, net of `commissionBps`:
   *
   *   netCents = grossRoyaltyCents - floor(grossRoyaltyCents * commissionBps / 10000)
   *
   * In ONE transaction it appends a `gateway_seller_earning_events` row AND
   * increments `gateway_seller_earnings.accrued_cents` for `orgId` by netCents.
   *
   * IDEMPOTENT on source_ref = `royalty-${input.runId}`: a re-settled / retried
   * run for the same runId accrues exactly once (later calls are a no-op).
   * No-op when `grossRoyaltyCents <= 0`.
   */
  accrueRoyalty(input: AccrueRoyaltyInput): Promise<void>;

  /**
   * Returns every org with a positive pending balance
   * (accrued_cents - transferred_cents > 0). Used by the P2 payout job.
   */
  getPendingSellerEarnings(): Promise<PendingSellerEarnings[]>;

  /**
   * Records a payout: increments `transferred_cents` for `orgId` by `amountCents`.
   * IDEMPOTENT on `transferRef` — replaying the same transfer is a no-op.
   */
  markSellerEarningsTransferred(
    orgId: string,
    amountCents: number,
    transferRef: string,
    now: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session store port (inbound/storage)
// ---------------------------------------------------------------------------

/**
 * Stores gateway sessions. Sessions are short-lived (TTL ~4 hours) and
 * append-only for message history.
 *
 * Both adapters implement identical behaviour:
 *   - AWS:       DynamoDB table with TTL on expiresAt.
 *   - Self-host: Postgres `gateway_sessions` table; an external cron or a lazy
 *                DELETE on read handles expired rows.
 */
export interface SessionStore {
  /**
   * Creates a new session. Returns the persisted GatewaySession.
   */
  createSession(input: CreateSessionInput): Promise<GatewaySession>;

  /**
   * Returns a session by id, or undefined if not found or expired.
   */
  getSession(sessionId: string): Promise<GatewaySession | undefined>;

  /**
   * Appends messages to the session's conversation history and bumps updatedAt.
   * Does NOT replace existing messages — this is an append-only operation.
   * Returns the updated session.
   */
  appendMessages(input: AppendSessionMessagesInput): Promise<GatewaySession>;

  /**
   * Replaces the entire message history of a session.
   * Used when the gateway needs to truncate history for context-window management.
   * Returns the updated session.
   */
  replaceMessages(
    sessionId: string,
    messages: ConversationMessage[],
    updatedAt: string,
  ): Promise<GatewaySession>;

  /**
   * Persists the in-flight turn state (credit hold, accumulated usage, pending
   * tool calls) for a session. Used by the streaming turn/tool-loop service to
   * pause ("awaiting_tool_results") and resume a turn across provider
   * round-trips. Bumps updatedAt. Returns the updated session.
   */
  setTurnState(
    sessionId: string,
    turnState: TurnState,
    updatedAt: string,
  ): Promise<GatewaySession>;

  /**
   * Deletes a session immediately (buyer-initiated DELETE /gateway/sessions/{id}).
   */
  deleteSession(sessionId: string): Promise<void>;
}
