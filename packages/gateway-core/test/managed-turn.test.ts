/**
 * Unit tests for runManagedTurn — the credit-gated managed inference flow.
 *
 * Uses an in-memory CreditLedgerRepository fake (correct two-phase-hold
 * semantics, never-negative guard) and a mock ChatProvider. No infrastructure.
 *
 * Cases:
 *   - happy path: hold reserved → provider called → settled with ACTUAL cost;
 *     overshoot returned; result reports debitedCents + post-settle balance.
 *   - insufficient balance: reserveHold fails → InsufficientCreditsError thrown
 *     and the provider is NEVER called.
 *   - provider error: hold reserved → provider throws → hold fully released
 *     (balance restored) → error rethrown.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatProvider, CreditLedgerRepository } from "../src/core/ports.js";
import type {
  ChatRequest,
  ChatResponse,
  CreditAccount,
  CreditHold,
  CreditTransaction,
  RecordTransactionInput,
} from "../src/core/types.js";
import {
  runManagedTurn,
  InsufficientCreditsError,
} from "../src/core/services/managed-turn.js";
import { computeDebitCents, computeMaxHoldCents } from "../src/core/pricing.js";
import { DEFAULT_MARKUP_BPS } from "../src/core/config.js";

// ---------------------------------------------------------------------------
// In-memory ledger fake (correct hold semantics + never-negative)
// ---------------------------------------------------------------------------

class InMemoryLedger implements CreditLedgerRepository {
  private accounts = new Map<string, CreditAccount>();
  private holds = new Map<string, CreditHold>();
  private txns: CreditTransaction[] = [];
  private holdSeq = 0;
  private txnSeq = 0;

  async getAccount(userId: string): Promise<CreditAccount | undefined> {
    return this.accounts.get(userId);
  }

  async ensureAccount(userId: string, now: string): Promise<CreditAccount> {
    let acc = this.accounts.get(userId);
    if (!acc) {
      acc = {
        userId,
        availableBalanceCents: 0,
        heldBalanceCents: 0,
        lifetimeTopupCents: 0,
        updatedAt: now,
      };
      this.accounts.set(userId, acc);
    }
    return acc;
  }

  async recordTransaction(input: RecordTransactionInput): Promise<CreditTransaction> {
    const txn: CreditTransaction = { transactionId: `txn-${++this.txnSeq}`, ...input };
    this.txns.push(txn);
    return txn;
  }

  async topup(userId: string, amountCents: number, now: string, sourceRef?: string): Promise<CreditAccount> {
    const acc = await this.ensureAccount(userId, now);
    acc.availableBalanceCents += amountCents;
    acc.lifetimeTopupCents += amountCents;
    acc.updatedAt = now;
    await this.recordTransaction({ userId, type: "topup", amountCents, createdAt: now, sourceRef });
    return acc;
  }

  async debit(userId: string, amountCents: number, now: string, description?: string, sourceRef?: string): Promise<CreditAccount> {
    const acc = await this.ensureAccount(userId, now);
    if (acc.availableBalanceCents < amountCents) throw new Error("insufficient balance");
    acc.availableBalanceCents -= amountCents;
    acc.updatedAt = now;
    await this.recordTransaction({ userId, type: "debit", amountCents, createdAt: now, description, sourceRef });
    return acc;
  }

  async reserveHold(userId: string, maxCostCents: number, now: string): Promise<string> {
    const acc = await this.ensureAccount(userId, now);
    if (acc.availableBalanceCents < maxCostCents) {
      // Mirror the adapter behaviour: throw on never-negative violation.
      throw new Error("ConditionalCheckFailedException: insufficient available balance");
    }
    acc.availableBalanceCents -= maxCostCents;
    acc.heldBalanceCents += maxCostCents;
    acc.updatedAt = now;
    const holdId = `hold-${++this.holdSeq}`;
    this.holds.set(holdId, { holdId, userId, reservedCents: maxCostCents, status: "open", createdAt: now });
    await this.recordTransaction({ userId, type: "hold", amountCents: maxCostCents, createdAt: now, holdId });
    return holdId;
  }

  async settleHold(holdId: string, actualCostCents: number, now: string, sourceRef?: string): Promise<CreditAccount> {
    const hold = this.holds.get(holdId);
    if (!hold) throw new Error(`Hold not found: ${holdId}`);
    if (hold.status !== "open") throw new Error(`Hold ${holdId} is already ${hold.status}`);
    const acc = this.accounts.get(hold.userId)!;
    const overshoot = Math.max(0, hold.reservedCents - actualCostCents);
    acc.heldBalanceCents -= hold.reservedCents;
    acc.availableBalanceCents += overshoot;
    acc.updatedAt = now;
    hold.status = "settled";
    hold.settledCents = actualCostCents;
    hold.settledAt = now;
    if (actualCostCents > 0) await this.recordTransaction({ userId: hold.userId, type: "debit", amountCents: actualCostCents, createdAt: now, holdId, sourceRef });
    if (overshoot > 0) await this.recordTransaction({ userId: hold.userId, type: "hold_release", amountCents: overshoot, createdAt: now, holdId });
    return acc;
  }

  async releaseHold(holdId: string, now: string): Promise<CreditAccount> {
    const hold = this.holds.get(holdId);
    if (!hold) throw new Error(`Hold not found: ${holdId}`);
    if (hold.status !== "open") throw new Error(`Hold ${holdId} is already ${hold.status}`);
    const acc = this.accounts.get(hold.userId)!;
    acc.availableBalanceCents += hold.reservedCents;
    acc.heldBalanceCents -= hold.reservedCents;
    acc.updatedAt = now;
    hold.status = "released";
    hold.settledAt = now;
    await this.recordTransaction({ userId: hold.userId, type: "hold_release", amountCents: hold.reservedCents, createdAt: now, holdId });
    return acc;
  }

  async getHold(holdId: string): Promise<CreditHold | undefined> {
    return this.holds.get(holdId);
  }

  async listTransactions(userId: string, limit = 50): Promise<CreditTransaction[]> {
    return this.txns.filter((t) => t.userId === userId).slice().reverse().slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-5";

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: MODEL,
    system: "You are a helpful kit.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: [{ type: "text", text: "hello" }],
    stopReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 500, cachedReadTokens: 0, cachedWriteTokens: 0 },
    ...overrides,
  };
}

/** A mock ChatProvider whose sendMessage is a vi.fn we can assert against. */
function makeProvider(impl: () => Promise<ChatResponse>): {
  provider: ChatProvider;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(impl);
  const provider: ChatProvider = {
    providerType: "anthropic",
    sendMessage: sendMessage as unknown as ChatProvider["sendMessage"],
    streamMessage: vi.fn() as unknown as ChatProvider["streamMessage"],
  };
  return { provider, sendMessage };
}

const NOW = "2026-06-17T12:00:00Z";
const now = () => NOW;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runManagedTurn", () => {
  let ledger: InMemoryLedger;

  beforeEach(() => {
    ledger = new InMemoryLedger();
  });

  it("happy path: reserves a hold, calls provider, settles ACTUAL cost, returns overshoot", async () => {
    await ledger.topup("user-1", 5000, NOW); // $50.00

    const usage = { inputTokens: 1000, outputTokens: 500, cachedReadTokens: 0, cachedWriteTokens: 0 };
    const response = makeResponse({ usage });
    const { provider, sendMessage } = makeProvider(async () => response);

    const request = makeRequest();
    const result = await runManagedTurn(
      { chatProvider: provider, ledger, now },
      { userId: "user-1", request, estimatedInputTokens: 800, sourceRef: "turn-1" },
    );

    // Provider was called exactly once with our request.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(request);

    // Debited the ACTUAL metered cost (with markup), not the conservative hold.
    const expectedDebit = computeDebitCents(usage, MODEL, DEFAULT_MARKUP_BPS);
    const expectedHold = computeMaxHoldCents(800, 1024, MODEL, DEFAULT_MARKUP_BPS);
    expect(result.debitedCents).toBe(expectedDebit);
    expect(expectedHold).toBeGreaterThan(expectedDebit); // hold was conservative

    // Balance == 5000 - actual debit; nothing left held (overshoot returned).
    expect(result.balanceCents).toBe(5000 - expectedDebit);
    const acc = await ledger.getAccount("user-1");
    expect(acc?.availableBalanceCents).toBe(5000 - expectedDebit);
    expect(acc?.heldBalanceCents).toBe(0);
    expect(result.response).toBe(response);

    // Hold settled with the actual cost.
    const txns = await ledger.listTransactions("user-1");
    const debit = txns.find((t) => t.type === "debit");
    expect(debit?.amountCents).toBe(expectedDebit);
    expect(debit?.sourceRef).toBe("turn-1");
  });

  it("insufficient balance: throws InsufficientCreditsError and NEVER calls the provider", async () => {
    await ledger.topup("user-1", 1, NOW); // 1¢ — far below any hold for 1024 maxTokens

    const { provider, sendMessage } = makeProvider(async () => makeResponse());

    await expect(
      runManagedTurn(
        { chatProvider: provider, ledger, now },
        { userId: "user-1", request: makeRequest(), estimatedInputTokens: 1000 },
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    // The provider must NOT have been called.
    expect(sendMessage).not.toHaveBeenCalled();

    // Balance untouched, nothing held.
    const acc = await ledger.getAccount("user-1");
    expect(acc?.availableBalanceCents).toBe(1);
    expect(acc?.heldBalanceCents).toBe(0);
  });

  it("InsufficientCreditsError carries userId, requiredCents, and availableCents", async () => {
    await ledger.topup("user-1", 1, NOW);
    const { provider } = makeProvider(async () => makeResponse());
    const expectedHold = computeMaxHoldCents(0, 1024, MODEL, DEFAULT_MARKUP_BPS);

    try {
      await runManagedTurn(
        { chatProvider: provider, ledger, now },
        { userId: "user-1", request: makeRequest() },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientCreditsError);
      const e = err as InsufficientCreditsError;
      expect(e.userId).toBe("user-1");
      expect(e.requiredCents).toBe(expectedHold);
      expect(e.availableCents).toBe(1);
    }
  });

  it("provider error: releases the full hold (balance restored) and rethrows", async () => {
    await ledger.topup("user-1", 5000, NOW);

    const boom = new Error("provider 500");
    const { provider, sendMessage } = makeProvider(async () => {
      throw boom;
    });

    await expect(
      runManagedTurn(
        { chatProvider: provider, ledger, now },
        { userId: "user-1", request: makeRequest(), estimatedInputTokens: 800 },
      ),
    ).rejects.toBe(boom);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Full balance restored, nothing held, nothing debited.
    const acc = await ledger.getAccount("user-1");
    expect(acc?.availableBalanceCents).toBe(5000);
    expect(acc?.heldBalanceCents).toBe(0);

    const txns = await ledger.listTransactions("user-1");
    expect(txns.find((t) => t.type === "debit")).toBeUndefined();
    // A hold and a hold_release should both be present.
    expect(txns.some((t) => t.type === "hold")).toBe(true);
    expect(txns.some((t) => t.type === "hold_release")).toBe(true);
  });

  it("respects a custom markupBps", async () => {
    await ledger.topup("user-1", 100000, NOW);
    const usage = { inputTokens: 2000, outputTokens: 1000, cachedReadTokens: 0, cachedWriteTokens: 0 };
    const { provider } = makeProvider(async () => makeResponse({ usage }));

    const result = await runManagedTurn(
      { chatProvider: provider, ledger, now, markupBps: 5000 },
      { userId: "user-1", request: makeRequest() },
    );

    expect(result.debitedCents).toBe(computeDebitCents(usage, MODEL, 5000));
  });
});
