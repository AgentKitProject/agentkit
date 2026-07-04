/**
 * PREMIUM (per-invocation) royalty WIRING (M6 P5).
 *
 * P1 already built the whole royalty split in the run-driver. P5 is the wiring
 * that threads the royalty context from the resolve seam → the run-driver deps so
 * the split actually fires. These tests assert that wiring END-TO-END through
 * processAutoRun (the worker entrypoint that both the in-process and worker paths
 * converge on):
 *
 *   - a PREMIUM resolve (premiumRoyaltyCents>0 + royaltyOrgId + royaltyKitId) makes
 *     the run-driver CHARGE the buyer (settleHold) + ACCRUE to the seller
 *     (accrueRoyalty) on a billable run, with the commissionBps passed through;
 *   - a NON-premium resolve leaves the fields undefined → the royalty path is
 *     INERT (no accrueRoyalty, spentRoyaltyCents === 0), byte-identical to today;
 *   - the same holds when the context arrives over the WORKER seam
 *     (ResolveContextResponse → toResolveKitContext), so the worker-dispatched run
 *     populates the deps identically.
 */

import { describe, expect, it } from "vitest";
import {
  processAutoRun,
  type ResolveKitContext,
} from "../src/entrypoints/worker.js";
import { toResolveKitContext, type ResolveContextResponse } from "../src/core/http-resolve-context.js";
import type { AutoStorageDeps } from "../src/core/ports.js";
import type {
  AccrueRoyaltyInput,
  CreditLedgerRepository,
} from "@agentkitforge/gateway-core";
import {
  FakeChatProvider,
  InMemoryRunRepo,
  InMemoryWorkspace,
  noopNow,
  textResponse,
} from "./fakes.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { InMemoryScheduleRepo } from "./schedule-repo-fake.js";
import { InMemoryWebhookRepo } from "./webhook-repo-fake.js";
import { LocalInputStore } from "../src/core/input-store.js";

/** A funded ledger that RECORDS the royalty-relevant calls so a test can assert
 *  the run-driver received (and acted on) the threaded royalty deps. */
class RecordingLedger implements CreditLedgerRepository {
  reserveHoldCalls: number[] = [];
  settleHoldCalls: number[] = [];
  accruals: AccrueRoyaltyInput[] = [];
  private seq = 0;
  async getAccount() {
    return { userId: "u1", availableBalanceCents: 1_000_000, heldBalanceCents: 0, lifetimeTopupCents: 0, updatedAt: noopNow() };
  }
  async ensureAccount() {
    return this.getAccount();
  }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: noopNow() };
  }
  async topup() {
    return this.getAccount();
  }
  async debit() {
    return this.getAccount();
  }
  async reserveHold(_userId: string, maxCostCents: number) {
    this.reserveHoldCalls.push(maxCostCents);
    return `h-${++this.seq}`;
  }
  async settleHold(_holdId: string, actualCents: number) {
    this.settleHoldCalls.push(actualCents);
    return this.getAccount();
  }
  async releaseHold() {
    return this.getAccount();
  }
  async getHold() {
    return undefined;
  }
  async listTransactions() {
    return [];
  }
  async getFreeMinutesUsed() {
    return 0;
  }
  async consumeFreeActiveMinutes(_userId: string, _yearMonth: string, runActiveMinutes: number) {
    return runActiveMinutes;
  }
  async accrueRoyalty(input: AccrueRoyaltyInput) {
    this.accruals.push(input);
  }
}

async function runWith(
  ledger: RecordingLedger,
  resolveKitContext: ResolveKitContext,
): Promise<Awaited<ReturnType<typeof processAutoRun>>> {
  const runs = new InMemoryRunRepo();
  const approvals = new InMemoryApprovalRepo();
  const workspaces = new InMemoryWorkspace();
  const schedules = new InMemoryScheduleRepo();
  const webhooks = new InMemoryWebhookRepo();
  const inputs = new LocalInputStore();
  const storage: AutoStorageDeps = { runs, approvals, workspaces, schedules, webhooks, inputs };

  await approvals.createApproval({
    userId: "u1",
    kitRef: { source: "market", marketKitId: "kit-777", slug: "premium-kit" },
    toolAllowlist: [],
    maxBudgetCents: 100_000,
    createdAt: noopNow(),
  });
  const run = await runs.createRun({
    userId: "u1",
    kitRef: { source: "market", marketKitId: "kit-777", slug: "premium-kit" },
    input: { prompt: "go" },
    budgetCents: 10_000,
    model: "claude-sonnet-4-6",
    createdAt: noopNow(),
  });

  return processAutoRun(run.id, {
    storage,
    chatProvider: new FakeChatProvider([textResponse("done")]),
    ledger,
    resolveKitContext,
    inferenceMode: "managed",
    now: noopNow,
    // v2 rates 0: with NO invocation/active-minute fee, the ONLY thing that makes
    // the run reserve+settle a hold is the threaded premium royalty. This isolates
    // the P5 wiring from the v2 run fee.
    invocationFeeCents: 0,
    activeMinuteRateCents: 0,
  });
}

describe("premium royalty wiring (M6 P5) through processAutoRun", () => {
  it("a premium resolve charges the buyer + accrues to the seller with commission passed through", async () => {
    const ledger = new RecordingLedger();
    // Resolver carrying the premium royalty context (as protected-kits.ts /
    // makeResolveKitContext would for a premium kit).
    const resolve: ResolveKitContext = async () => ({
      systemPrompt: "secret kit prompt",
      tools: [],
      toolNames: [],
      protected: true,
      premiumRoyaltyCents: 250,
      royaltyOrgId: "org-seller",
      royaltyKitId: "kit-777",
      royaltyCommissionBps: 600,
    });

    const out = await runWith(ledger, resolve);

    expect(out.status).toBe("succeeded");
    // The buyer was charged the royalty within the hold.
    expect(ledger.reserveHoldCalls).toContain(250);
    expect(ledger.settleHoldCalls).toContain(250);
    expect(out.spentRoyaltyCents).toBe(250);
    // spentCents includes the royalty (a separate receipt line beyond compute).
    expect(out.spentCents).toBe(out.spentInferenceCents + out.spentComputeCents + 250);
    // The seller org accrued exactly once, with the pass-through commission.
    expect(ledger.accruals).toHaveLength(1);
    expect(ledger.accruals[0]).toMatchObject({
      orgId: "org-seller",
      kitId: "kit-777",
      grossRoyaltyCents: 250,
      commissionBps: 600,
    });
  });

  it("a non-premium resolve leaves the royalty path inert (no accrual, no royalty spend)", async () => {
    const ledger = new RecordingLedger();
    // Local / free kit resolve — no royalty fields.
    const resolve: ResolveKitContext = async () => ({
      systemPrompt: "just a prompt",
      tools: [],
      toolNames: [],
    });

    const out = await runWith(ledger, resolve);

    expect(out.status).toBe("succeeded");
    expect(out.spentRoyaltyCents).toBe(0);
    expect(out.spentCents).toBe(out.spentInferenceCents + out.spentComputeCents);
    // With rates 0 AND no royalty, the v2/royalty fee path never runs: no seller
    // accrual and no royalty charge — byte-identical to the pre-P5 non-premium path.
    // (Managed inference still does its OWN per-turn two-phase hold via
    // runManagedTurn; that is inference billing, unrelated to the royalty wiring.)
    expect(ledger.accruals).toEqual([]);
  });

  it("carries the royalty over the WORKER seam (ResolveContextResponse → toResolveKitContext)", async () => {
    const ledger = new RecordingLedger();
    // The exact JSON shape web-forge returns over /api/internal/auto/resolve-context
    // for a premium kit, deserialized by the worker.
    const payload: ResolveContextResponse = {
      systemPrompt: "secret kit prompt",
      tools: [],
      toolNames: [],
      inferenceMode: "managed",
      protected: true,
      premiumRoyaltyCents: 500,
      royaltyOrgId: "org-seller",
      royaltyKitId: "kit-777",
      royaltyCommissionBps: 600,
    };

    const out = await runWith(ledger, toResolveKitContext(payload));

    expect(out.status).toBe("succeeded");
    expect(out.spentRoyaltyCents).toBe(500);
    expect(ledger.accruals).toHaveLength(1);
    expect(ledger.accruals[0]).toMatchObject({
      orgId: "org-seller",
      kitId: "kit-777",
      grossRoyaltyCents: 500,
      commissionBps: 600,
    });
  });

  it("the worker seam stays inert when the royalty fields are absent", async () => {
    const ledger = new RecordingLedger();
    const payload: ResolveContextResponse = {
      systemPrompt: "just a prompt",
      tools: [],
      toolNames: [],
      inferenceMode: "managed",
    };

    const out = await runWith(ledger, toResolveKitContext(payload));

    expect(out.status).toBe("succeeded");
    expect(out.spentRoyaltyCents).toBe(0);
    expect(ledger.accruals).toEqual([]);
  });
});
