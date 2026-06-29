/**
 * Managed-turn service — the credit-gated single-turn inference flow.
 *
 * This is the heart of the MANAGED billing mode: the gateway uses OUR provider
 * API key and charges the buyer's prepaid credit balance for the call.
 *
 * Flow (two-phase hold, never under-charge, never extend credit):
 *
 *   1. ensureAccount(userId)                  — lazily create the ledger row.
 *   2. computeMaxHoldCents(...)               — conservative pre-call cost ceiling.
 *   3. reserveHold(userId, maxHold)           — atomically move funds available→held.
 *        └─ if balance insufficient → throw InsufficientCreditsError, NO provider call.
 *   4. ChatProvider.sendMessage(request)      — the actual model call (our key).
 *        ├─ on SUCCESS → settleHold(holdId, computeDebitCents(reportedUsage, ...))
 *        │               (debits actual cost, releases the overshoot)
 *        └─ on ERROR   → releaseHold(holdId)  (full reservation returned, then rethrow)
 *
 * The service is "pure-ish": it performs NO direct I/O of its own. All side
 * effects flow through the injected `ChatProvider` + `CreditLedgerRepository`
 * ports and the injected `now()` clock, so it is fully unit-testable with
 * in-memory fakes.
 *
 * INVARIANTS:
 *   - No provider call is ever made if the pre-call hold cannot be reserved.
 *   - On any provider error the full hold is released (the buyer is not charged).
 *   - On success the buyer is charged the ACTUAL metered cost (with markup),
 *     and any overshoot from the conservative hold is returned.
 *   - This service is for MANAGED mode only. BYO callers must NOT route here
 *     (the ledger is not touched for BYO).
 */

import type { ChatProvider, CreditLedgerRepository } from "../ports.js";
import type { ChatRequest, ChatResponse } from "../types.js";
import { computeDebitCents, computeMaxHoldCents } from "../pricing.js";
import { DEFAULT_MARKUP_BPS } from "../config.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown BEFORE any provider call when the buyer's available balance cannot
 * cover the conservative pre-call hold. Managed mode is hard-stop at zero
 * balance: we never extend credit or charge after the fact.
 */
export class InsufficientCreditsError extends Error {
  readonly name = "InsufficientCreditsError";
  /** The user whose balance was insufficient. */
  readonly userId: string;
  /** The hold amount (in cents) we tried and failed to reserve. */
  readonly requiredCents: number;
  /** The user's available balance at the time of the failed reservation, if known. */
  readonly availableCents: number | undefined;

  constructor(userId: string, requiredCents: number, availableCents?: number) {
    super(
      `Insufficient credits for user ${userId}: need ${requiredCents}¢` +
        (availableCents !== undefined ? `, have ${availableCents}¢` : "") +
        ". Top up to continue.",
    );
    this.userId = userId;
    this.requiredCents = requiredCents;
    this.availableCents = availableCents;
  }
}

// ---------------------------------------------------------------------------
// Inputs / outputs / deps
// ---------------------------------------------------------------------------

/** Dependencies injected at the composition root (Lambda / self-host server). */
export interface ManagedTurnDeps {
  /** The chat provider configured with OUR (managed) provider key. */
  chatProvider: ChatProvider;
  /** The credit ledger backing this deployment (DynamoDB or Postgres). */
  ledger: CreditLedgerRepository;
  /** Clock — returns an ISO 8601 timestamp. Injected for deterministic tests. */
  now: () => string;
  /**
   * Markup in basis points. Defaults to DEFAULT_MARKUP_BPS (0 = at cost).
   * Override per-deployment via GATEWAY_MARKUP_BPS at the composition root.
   */
  markupBps?: number;
}

export interface ManagedTurnInput {
  /** The buyer / authenticated user whose balance is charged. */
  userId: string;
  /** The fully-assembled provider request (system + history + tools + maxTokens). */
  request: ChatRequest;
  /**
   * Estimated prompt (input) token count used to size the conservative hold.
   * The caller (turn route) estimates this from system + history + user turn.
   * Defaults to 0, in which case the hold covers only the worst-case output.
   */
  estimatedInputTokens?: number;
  /**
   * Optional source reference threaded into ledger transactions for traceability
   * (e.g. gateway turn id / sessionId).
   */
  sourceRef?: string;
}

export interface ManagedTurnResult {
  /** The provider response. */
  response: ChatResponse;
  /** The amount actually debited from the buyer's balance, in US cents. */
  debitedCents: number;
  /** The buyer's available balance AFTER settlement, in US cents. */
  balanceCents: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Runs a single managed (credit-gated) inference turn.
 *
 * @throws InsufficientCreditsError  if the pre-call hold cannot be reserved
 *                                   (no provider call is made).
 * @throws (provider error)          rethrown after the hold is released; the
 *                                   buyer is not charged.
 */
export async function runManagedTurn(
  deps: ManagedTurnDeps,
  input: ManagedTurnInput,
): Promise<ManagedTurnResult> {
  const markupBps = deps.markupBps ?? DEFAULT_MARKUP_BPS;
  const { userId, request, sourceRef } = input;
  const estimatedInputTokens = input.estimatedInputTokens ?? 0;

  // 1. Ensure the ledger row exists (idempotent).
  await deps.ledger.ensureAccount(userId, deps.now());

  // 2. Conservative pre-call hold: worst-case input + full maxTokens output.
  const maxHoldCents = computeMaxHoldCents(
    estimatedInputTokens,
    request.maxTokens,
    request.model,
    markupBps,
  );

  // 3. Reserve the hold. Insufficient balance → typed error, NO provider call.
  let holdId: string;
  try {
    holdId = await deps.ledger.reserveHold(userId, maxHoldCents, deps.now());
  } catch (err) {
    // The ledger throws (condition-check failure) when the balance would go
    // negative. Surface a typed, caller-friendly error instead.
    const account = await deps.ledger.getAccount(userId).catch(() => undefined);
    throw new InsufficientCreditsError(
      userId,
      maxHoldCents,
      account?.availableBalanceCents,
    );
  }

  // 4. Make the actual provider call with OUR managed key.
  let response: ChatResponse;
  try {
    response = await deps.chatProvider.sendMessage(request);
  } catch (providerError) {
    // Provider failed → release the full hold (buyer not charged), then rethrow.
    await deps.ledger.releaseHold(holdId, deps.now());
    throw providerError;
  }

  // 5. Success → debit the ACTUAL metered cost (with markup); release overshoot.
  const debitedCents = computeDebitCents(response.usage, request.model, markupBps);
  const account = await deps.ledger.settleHold(
    holdId,
    debitedCents,
    deps.now(),
    sourceRef,
  );

  return {
    response,
    debitedCents,
    balanceCents: account.availableBalanceCents,
  };
}
