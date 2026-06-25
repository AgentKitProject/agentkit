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
  CreditAccount,
  CreditHold,
  CreditTransaction,
  RecordTransactionInput,
} from "../../core/types.js";

export class InMemoryCreditLedgerRepository implements CreditLedgerRepository {
  readonly accounts = new Map<string, CreditAccount>();
  readonly holds = new Map<string, CreditHold>();
  readonly txns: CreditTransaction[] = [];
  private holdSeq = 0;
  private txnSeq = 0;

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
}
