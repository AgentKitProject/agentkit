/**
 * In-memory credit ledger adapter.
 *
 * A zero-dependency, single-process implementation of CreditLedgerRepository
 * with correct two-phase-hold semantics and the never-negative invariant. It is
 * the default ledger for the free / BYO path and for tests that exercise the
 * managed-turn / router / streaming-turn flows without infrastructure.
 *
 * NOT durable: state lives in memory and is lost on restart. For hosted billing
 * use a persistent ledger adapter; this one is for local-first, BYO, and test
 * deployments where credit balances need not survive a process restart.
 *
 * INVARIANTS (same as the persistent adapters):
 *   1. availableBalanceCents >= 0 at all times.
 *   2. Transactions are append-only.
 *   3. Holds are settled or released exactly once.
 */

import type { CreditLedgerRepository } from "../../core/ports.js";
import type {
  AccrueRoyaltyInput,
  CreditAccount,
  CreditHold,
  CreditTransaction,
  PendingSellerEarnings,
  RecordTransactionInput,
} from "../../core/types.js";

export class InMemoryCreditLedgerRepository implements CreditLedgerRepository {
  readonly accounts = new Map<string, CreditAccount>();
  readonly holds = new Map<string, CreditHold>();
  readonly txns: CreditTransaction[] = [];
  private holdSeq = 0;
  private txnSeq = 0;
  /** Auto v2 free active-minute usage, keyed "userId\x00yearMonth" → minutes. */
  private readonly freeMinuteUsage = new Map<string, number>();
  /**
   * Idempotency record for consumeFreeActiveMinutes, keyed by runId → the
   * billableMinutes returned on first application. A re-settle of the same run
   * replays this value and writes nothing further (no double-deplete).
   */
  private readonly freeMinuteRuns = new Map<string, number>();

  // -------------------------------------------------------------------------
  // Seller-earnings ledger (premium / per-invocation kit royalties)
  // -------------------------------------------------------------------------
  /** Per-org accrued (net) cents from run royalties. */
  private readonly sellerAccrued = new Map<string, number>();
  /** Per-org transferred (paid-out) cents. */
  private readonly sellerTransferred = new Map<string, number>();
  /** Seen accrual source_refs (`royalty-${runId}`) for idempotency. */
  private readonly seenRoyaltyRefs = new Set<string>();
  /** Seen payout transferRefs for idempotency. */
  private readonly seenTransferRefs = new Set<string>();

  async getAccount(userId: string): Promise<CreditAccount | undefined> {
    return this.accounts.get(userId);
  }

  async ensureAccount(userId: string, now: string): Promise<CreditAccount> {
    let acc = this.accounts.get(userId);
    if (!acc) {
      acc = { userId, availableBalanceCents: 0, heldBalanceCents: 0, lifetimeTopupCents: 0, updatedAt: now };
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

  private usageKey(userId: string, yearMonth: string): string {
    return `${userId}\x00${yearMonth}`;
  }

  async getFreeMinutesUsed(userId: string, yearMonth: string): Promise<number> {
    return this.freeMinuteUsage.get(this.usageKey(userId, yearMonth)) ?? 0;
  }

  async consumeFreeActiveMinutes(
    userId: string,
    yearMonth: string,
    runActiveMinutes: number,
    freeAllowance: number,
    runId: string,
  ): Promise<number> {
    // Idempotent replay: a re-settle of the same run returns its first result
    // and writes nothing further (no double-deplete, no double-charge).
    const prior = this.freeMinuteRuns.get(runId);
    if (prior !== undefined) return prior;

    const minutes = Math.max(0, Math.trunc(runActiveMinutes));
    const allowance = Math.max(0, Math.trunc(freeAllowance));
    const key = this.usageKey(userId, yearMonth);
    const usedThisMonth = this.freeMinuteUsage.get(key) ?? 0;
    const freeRemaining = Math.max(0, allowance - usedThisMonth);
    const billableMinutes = Math.max(0, minutes - freeRemaining);

    this.freeMinuteUsage.set(key, usedThisMonth + minutes);
    this.freeMinuteRuns.set(runId, billableMinutes);
    return billableMinutes;
  }

  // -------------------------------------------------------------------------
  // Seller-earnings ledger (premium / per-invocation kit royalties)
  // -------------------------------------------------------------------------

  async accrueRoyalty(input: AccrueRoyaltyInput): Promise<void> {
    const { orgId, runId, grossRoyaltyCents, commissionBps } = input;
    // No-op on a non-positive gross royalty.
    if (!(grossRoyaltyCents > 0)) return;
    // Idempotent on source_ref = `royalty-${runId}`: a replay accrues nothing.
    const sourceRef = `royalty-${runId}`;
    if (this.seenRoyaltyRefs.has(sourceRef)) return;
    this.seenRoyaltyRefs.add(sourceRef);
    const commissionCents = Math.floor((grossRoyaltyCents * Math.max(0, commissionBps)) / 10000);
    const netCents = grossRoyaltyCents - commissionCents;
    this.sellerAccrued.set(orgId, (this.sellerAccrued.get(orgId) ?? 0) + netCents);
  }

  async getPendingSellerEarnings(): Promise<PendingSellerEarnings[]> {
    const orgs = new Set<string>([...this.sellerAccrued.keys(), ...this.sellerTransferred.keys()]);
    const pending: PendingSellerEarnings[] = [];
    for (const orgId of [...orgs].sort()) {
      const transferredCents = this.sellerTransferred.get(orgId) ?? 0;
      const pendingCents = (this.sellerAccrued.get(orgId) ?? 0) - transferredCents;
      if (pendingCents > 0) pending.push({ orgId, pendingCents, transferredCents });
    }
    return pending;
  }

  async markSellerEarningsTransferred(
    orgId: string,
    amountCents: number,
    transferRef: string,
    _now: string,
  ): Promise<void> {
    // Idempotent on transferRef: replaying the same transfer bumps nothing.
    if (this.seenTransferRefs.has(transferRef)) return;
    this.seenTransferRefs.add(transferRef);
    this.sellerTransferred.set(orgId, (this.sellerTransferred.get(orgId) ?? 0) + amountCents);
  }
}
