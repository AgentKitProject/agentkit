/**
 * AgentKitAuto v2 billing model — run-based fees (invocation + active-minute).
 *
 * Auto v2 replaced the per-token markup with a RUN-based compute charge:
 *   - a flat INVOCATION fee, debited ONCE at run start (idempotent sourceRef
 *     `auto-invocation-{runId}`);
 *   - a per-ACTIVE-MINUTE fee, ceil(wall-clock minutes) * rate, reserved up-front
 *     and settled at finalize (sourceRef `auto-active-{runId}`).
 * Both apply to EVERY run (managed AND BYO). Token inference is billed AT COST
 * (markup 0). The fees are 0 (the whole path skipped) on the open-core / self-host
 * FREE path so a self-host pays nothing.
 *
 * Deterministic + offline: a scripted FakeChatProvider, a funded tracking ledger,
 * and a controllable ISO clock.
 */

import { describe, expect, it } from "vitest";
import { FREE_TRIAL_PERIOD_KEY } from "@agentkitforge/gateway-core";
import {
  computeDebitCents,
  type AccrueRoyaltyInput,
  type CreditLedgerRepository,
} from "@agentkitforge/gateway-core";
import { runAutoRun } from "../src/core/run-driver.js";
import { makeSandboxExecutor } from "../src/core/sandbox-executor.js";
import type { AutoApproval, AutoRun, InferenceMode } from "../src/core/types.js";
import type { ChatResponse, ContentBlock } from "@agentkitforge/gateway-core";
import {
  FakeChatProvider,
  InMemoryRunRepo,
  InMemoryWorkspace,
  textResponse,
  toolUseResponse,
} from "./fakes.js";

/** A text response with a large, billing-distinguishable token usage. */
function bigTextResponse(text: string): ChatResponse {
  return {
    content: [{ type: "text", text }] as ContentBlock[],
    stopReason: "end_turn",
    usage: BIG_USAGE,
  };
}

const ACCOUNT = {
  userId: "u1",
  availableBalanceCents: 1_000_000,
  heldBalanceCents: 0,
  lifetimeTopupCents: 0,
  updatedAt: "2026-06-18T00:00:00.000Z",
};

interface SettleCall {
  holdId: string;
  cents: number;
  sourceRef?: string;
}

interface DebitCall {
  cents: number;
  description?: string;
  sourceRef?: string;
}

/** Funded ledger that records every reserve/settle/debit so tests can assert the
 *  exact debited amounts (invocation fee + active-minute fee). */
class TrackingLedger implements CreditLedgerRepository {
  reserves: { cents: number }[] = [];
  settles: SettleCall[] = [];
  releases: string[] = [];
  debits: DebitCall[] = [];
  private seq = 0;
  /** When set, reserveHold throws to simulate insufficient funds. */
  rejectReserve = false;
  /** When set, the up-front invocation debit throws to simulate insufficient funds. */
  rejectDebit = false;

  async getAccount() {
    return ACCOUNT;
  }
  async ensureAccount() {
    return ACCOUNT;
  }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: ACCOUNT.updatedAt };
  }
  async topup() {
    return ACCOUNT;
  }
  async debit(_userId: string, amountCents: number, _now: string, description?: string, sourceRef?: string) {
    if (this.rejectDebit) throw new Error("condition check failed: balance");
    this.debits.push({ cents: amountCents, description, sourceRef });
    return ACCOUNT;
  }
  async reserveHold(_userId: string, maxCostCents: number) {
    if (this.rejectReserve) throw new Error("condition check failed: balance");
    this.reserves.push({ cents: maxCostCents });
    return `h-${++this.seq}`;
  }
  async settleHold(holdId: string, actualCostCents: number, _now: string, sourceRef?: string) {
    this.settles.push({ holdId, cents: actualCostCents, sourceRef });
    return ACCOUNT;
  }
  async releaseHold(holdId: string) {
    this.releases.push(holdId);
    return ACCOUNT;
  }
  async getHold() {
    return undefined;
  }
  async listTransactions() {
    return [];
  }

  // Premium (per-invocation) seller-earnings — record every accrual so the split
  // tests can assert the seller was (or was NOT) accrued, with idempotency.
  accruals: AccrueRoyaltyInput[] = [];
  private seenRoyaltyRefs = new Set<string>();
  async accrueRoyalty(input: AccrueRoyaltyInput) {
    if (!(input.grossRoyaltyCents > 0)) return;
    const ref = `royalty-${input.runId}`;
    if (this.seenRoyaltyRefs.has(ref)) return; // idempotent per runId
    this.seenRoyaltyRefs.add(ref);
    this.accruals.push(input);
  }
  async getPendingSellerEarnings() {
    return [];
  }
  async markSellerEarningsTransferred() {
    /* unused in these tests */
  }

  // Auto v2 Slice 2: per-(user, month) free-minute usage + per-run idempotency,
  // mirroring InMemoryCreditLedgerRepository so the run-driver's free-tier path
  // is exercised against a realistic ledger.
  freeUsage = new Map<string, number>();
  private freeRuns = new Map<string, number>();
  consumeFreeCalls: { runId: string; runActiveMinutes: number; freeAllowance: number; yearMonth: string }[] = [];
  async getFreeMinutesUsed(userId: string, yearMonth: string) {
    return this.freeUsage.get(`${userId}\x00${yearMonth}`) ?? 0;
  }
  async consumeFreeActiveMinutes(
    userId: string,
    yearMonth: string,
    runActiveMinutes: number,
    freeAllowance: number,
    runId: string,
  ) {
    this.consumeFreeCalls.push({ runId, runActiveMinutes, freeAllowance, yearMonth });
    const prior = this.freeRuns.get(runId);
    if (prior !== undefined) return prior;
    const minutes = Math.max(0, Math.trunc(runActiveMinutes));
    const allowance = Math.max(0, Math.trunc(freeAllowance));
    const key = `${userId}\x00${yearMonth}`;
    const used = this.freeUsage.get(key) ?? 0;
    const freeRemaining = Math.max(0, allowance - used);
    const billable = Math.max(0, minutes - freeRemaining);
    this.freeUsage.set(key, used + minutes);
    this.freeRuns.set(runId, billable);
    return billable;
  }
}

/** A clock that returns a fixed base time, advanceable by whole minutes. */
function makeClock(baseMs = Date.parse("2026-06-18T00:00:00.000Z")) {
  let offsetMs = 0;
  const now = () => new Date(baseMs + offsetMs).toISOString();
  return { now, advanceMinutes: (m: number) => { offsetMs += m * 60_000; } };
}

const APPROVAL: AutoApproval = {
  id: "appr-1",
  userId: "u1",
  kitRef: { source: "local", localKitId: "k1" },
  scope: "workspace_read_write",
  toolAllowlist: ["write_file"],
  networkPolicy: { mode: "deny_all" },
  maxBudgetCents: 1_000_000,
  createdAt: "2026-06-18T00:00:00.000Z",
  revokedAt: null,
};

async function setup(opts: { budgetCents: number; inferenceMode?: InferenceMode }) {
  const runs = new InMemoryRunRepo();
  const workspace = new InMemoryWorkspace();
  const workspaceId = await workspace.createWorkspace("run-1");
  const run: AutoRun = {
    id: "run-1",
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    status: "running",
    input: { prompt: "do it" },
    budgetCents: opts.budgetCents,
    spentCents: 0,
    spentInferenceCents: 0,
    spentComputeCents: 0,
    inferenceMode: opts.inferenceMode ?? "managed",
    model: "claude-sonnet-4-6",
    createdAt: "2026-06-18T00:00:00.000Z",
    auditLog: [],
    workspaceId,
  };
  runs.seed(run);
  return { runs, workspace, workspaceId, run };
}

const USAGE = { inputTokens: 100, outputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 };
/** Large usage so distinct markups produce distinct cent amounts (> 1¢ floor). */
const BIG_USAGE = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 0, cachedWriteTokens: 0 };

// The slice-1 commercial v2 rates (mirrors @agentkit-commercial/gateway).
const INVOCATION = 1; // cents
const ACTIVE_MIN = 1; // cents/min

const invocationSettles = (l: TrackingLedger) =>
  l.debits.filter((d) => d.sourceRef === "auto-invocation-run-1");
const activeSettles = (l: TrackingLedger) =>
  l.settles.filter((s) => s.sourceRef === "auto-active-run-1");
const inferenceSettles = (l: TrackingLedger) =>
  l.settles.filter((s) => !s.sourceRef?.startsWith("auto-active-"));

describe("Auto v2 billing: token markup", () => {
  it("managed turns bill inference AT COST (markup 0) when no markup is passed", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 100_000_000 });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([bigTextResponse("done")]);
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    // No markupBps passed → run-driver forwards none → runManagedTurn uses the
    // gateway DEFAULT_MARKUP_BPS, which is now 0 (tokens at cost).
    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "managed", maxTokens: 1_000_000 },
    });

    expect(out.status).toBe("succeeded");
    const atCost = computeDebitCents(BIG_USAGE, "claude-sonnet-4-6", 0);
    expect(inferenceSettles(ledger)).toHaveLength(1);
    expect(inferenceSettles(ledger)[0]!.cents).toBe(atCost);
    expect(out.spentInferenceCents).toBe(atCost);
    // No v2 fee rates passed → no run fee.
    expect(out.spentComputeCents).toBe(0);
  });
});

describe("Auto v2 billing: invocation fee", () => {
  it("debits the invocation fee ONCE at run start with the idempotent sourceRef", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 100_000 });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([textResponse("done")]);
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "managed", maxTokens: 100,
        invocationFeeCents: INVOCATION, activeMinuteRateCents: 0,
      },
    });

    expect(out.status).toBe("succeeded");
    const inv = invocationSettles(ledger);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.cents).toBe(INVOCATION);
    expect(inv[0]!.sourceRef).toBe("auto-invocation-run-1");
    // No active-minute rate → no active-minute hold/settle. (The managed
    // inference path still reserves+settles its own hold — not a v2 run fee.)
    expect(activeSettles(ledger)).toHaveLength(0);
    expect(out.spentInvocationCents).toBe(INVOCATION);
    expect(out.spentActiveMinuteCents).toBe(0);
    expect(out.spentComputeCents).toBe(INVOCATION);
  });

  it("charges the invocation fee even on a 0-minute run", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 100_000 });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([textResponse("done")]); // clock never advances
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "managed", maxTokens: 100,
        invocationFeeCents: INVOCATION, activeMinuteRateCents: ACTIVE_MIN,
      },
    });

    expect(out.status).toBe("succeeded");
    expect(out.spentInvocationCents).toBe(INVOCATION);
    // 0 elapsed minutes → ceil(0) * rate = 0.
    expect(out.spentActiveMinuteCents).toBe(0);
    expect(activeSettles(ledger)[0]!.cents).toBe(0);
  });
});

describe("Auto v2 billing: active-minute fee", () => {
  it("reserves a budget-derived hold up-front and settles ceil(minutes) * rate", async () => {
    const RATE = 5; // cents/min
    const { runs, workspace, run } = await setup({ budgetCents: 100 }); // estMin = ceil(100/5) = 20
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    // Advance the clock ~3.5 minutes during the model call.
    const slowProvider = new FakeChatProvider([textResponse("done")]);
    const origSend = slowProvider.sendMessage.bind(slowProvider);
    slowProvider.sendMessage = async (req) => {
      clock.advanceMinutes(3.5);
      return origSend(req);
    };

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: slowProvider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: RATE,
      },
    });

    expect(out.status).toBe("succeeded");
    // Up-front hold = estMin (20) * rate (5) = 100.
    expect(ledger.reserves).toHaveLength(1);
    expect(ledger.reserves[0]!.cents).toBe(100);
    // Settled active-minutes = ceil(3.5) * 5 = 20.
    const active = activeSettles(ledger);
    expect(active).toHaveLength(1);
    expect(active[0]!.cents).toBe(20);
    expect(active[0]!.sourceRef).toBe("auto-active-run-1");
    expect(out.spentActiveMinuteCents).toBe(20);
    expect(out.spentInferenceCents).toBe(0); // BYO → no inference debit
    expect(out.spentComputeCents).toBe(20);
    expect(out.spentCents).toBe(20);
    expect((await runs.getRun("run-1"))?.spentComputeCents).toBe(20);
  });

  it("applies to MANAGED runs too (invocation + active-minute alongside at-cost inference)", async () => {
    const RATE = 5;
    const { runs, workspace, run } = await setup({ budgetCents: 100_000, inferenceMode: "managed" });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const slowProvider = new FakeChatProvider([textResponse("done")]);
    const origSend = slowProvider.sendMessage.bind(slowProvider);
    slowProvider.sendMessage = async (req) => {
      clock.advanceMinutes(2);
      return origSend(req);
    };

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: slowProvider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "managed", maxTokens: 100,
        invocationFeeCents: INVOCATION, activeMinuteRateCents: RATE,
      },
    });

    expect(out.status).toBe("succeeded");
    expect(out.spentInvocationCents).toBe(INVOCATION);
    expect(out.spentActiveMinuteCents).toBe(2 * RATE); // ceil(2) * 5
    expect(out.spentComputeCents).toBe(INVOCATION + 2 * RATE);
    // Inference still billed (at cost, markup 0 default).
    const inf = inferenceSettles(ledger);
    expect(inf).toHaveLength(1);
    expect(out.spentInferenceCents).toBe(computeDebitCents(USAGE, "claude-sonnet-4-6", 0));
  });

  it("settles the active-minute hold on FAILURE (provider throws)", async () => {
    const RATE = 5;
    const { runs, workspace, run } = await setup({ budgetCents: 100, inferenceMode: "byo" });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const provider = new FakeChatProvider([]); // empty → throws
    const origSend = provider.sendMessage.bind(provider);
    provider.sendMessage = async (req) => {
      clock.advanceMinutes(1.2); // 1.2 min before the throw → ceil = 2
      return origSend(req);
    };
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: RATE,
      },
    });

    expect(out.status).toBe("failed");
    const active = activeSettles(ledger);
    expect(active).toHaveLength(1);
    expect(active[0]!.cents).toBe(Math.ceil(1.2) * RATE); // 2 * 5 = 10
    expect(out.spentActiveMinuteCents).toBe(10);
  });

  it("settles the active-minute hold on CANCEL (kill-switch)", async () => {
    const RATE = 5;
    const { runs, workspace, run } = await setup({ budgetCents: 100, inferenceMode: "byo" });
    const ledger = new TrackingLedger();
    const clock = makeClock();
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "a.txt", content: "x" }),
      textResponse("unreached"),
    ]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, resolvedTools: ["write_file"], now: clock.now });
    const exec2 = async (tu: Parameters<typeof exec>[0]) => {
      clock.advanceMinutes(0.4);
      await runs.requestCancel("run-1");
      return exec(tu);
    };

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [{ name: "write_file", description: "", inputSchema: {} }],
      executeTool: exec2,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: RATE,
      },
    });

    expect(out.status).toBe("canceled");
    const active = activeSettles(ledger);
    expect(active).toHaveLength(1);
    expect(active[0]!.cents).toBe(Math.ceil(0.4) * RATE); // 1 * 5 = 5
  });

  it("rejects (throws → failed) when the up-front active-minute hold can't be reserved", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 100, inferenceMode: "byo" });
    const ledger = new TrackingLedger();
    ledger.rejectReserve = true;
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("unreached")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: 5,
      },
    });

    expect(out.status).toBe("failed");
    expect(provider.calls).toBe(0); // never reached the provider
    expect(out.spentComputeCents).toBe(0);
  });
});

describe("Auto v2 billing: open-core / self-host FREE (fees disabled)", () => {
  it("BYO with 0/0 rates touches the ledger for NOTHING", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 1_000_000, inferenceMode: "byo" });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([textResponse("done")]);
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: 0,
      },
    });

    expect(out.status).toBe("succeeded");
    expect(provider.calls).toBe(1); // the BYO provider WAS called
    expect(ledger.debits).toHaveLength(0); // no invocation debit
    expect(ledger.reserves).toHaveLength(0); // no active-minute hold
    expect(ledger.settles).toHaveLength(0); // no inference debit (BYO)
    expect(out.spentInferenceCents).toBe(0);
    expect(out.spentComputeCents).toBe(0);
  });

  it("default deps (no v2 rates) = no run fee (managed inference still billed at cost)", async () => {
    const { runs, workspace, run } = await setup({ budgetCents: 1_000_000, inferenceMode: "managed" });
    const ledger = new TrackingLedger();
    const provider = new FakeChatProvider([textResponse("done")]);
    const clock = makeClock();
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });

    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: { chatProvider: provider, ledger, runs, workspace, now: clock.now, inferenceMode: "managed", maxTokens: 100 },
    });

    expect(out.status).toBe("succeeded");
    expect(ledger.debits).toHaveLength(0); // no invocation debit
    // No v2 active-minute hold. (The managed INFERENCE path still reserves+settles
    // its own hold via runManagedTurn — that is not a v2 run fee.)
    expect(activeSettles(ledger)).toHaveLength(0);
    expect(out.spentComputeCents).toBe(0);
    expect(out.spentInvocationCents).toBe(0);
    expect(out.spentActiveMinuteCents).toBe(0);
    expect(out.spentInferenceCents).toBe(computeDebitCents(USAGE, "claude-sonnet-4-6", 0));
  });
});

describe("Auto v2 billing: free active-minute allowance (Slice 2)", () => {
  const RATE = 1; // cents/min
  const FREE = 60; // free minutes/month

  /** Run a single BYO run that consumes `activeMin` whole minutes, with a given
   *  free allowance, on a shared ledger. The run's id/month/budget are
   *  parameterized so a test can drive several runs in (or across) months. */
  async function runWith(opts: {
    ledger: TrackingLedger;
    activeMin: number;
    freeAllowance: number;
    runId: string;
    baseIso?: string;
    budgetCents?: number;
  }) {
    const baseMs = Date.parse(opts.baseIso ?? "2026-06-18T00:00:00.000Z");
    const { runs, workspace, run } = await setup({
      budgetCents: opts.budgetCents ?? 100_000,
      inferenceMode: "byo",
    });
    run.id = opts.runId;
    run.createdAt = new Date(baseMs).toISOString();
    const clock = makeClock(baseMs);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const provider = new FakeChatProvider([textResponse("done")]);
    const origSend = provider.sendMessage.bind(provider);
    provider.sendMessage = async (req) => {
      clock.advanceMinutes(opts.activeMin);
      return origSend(req);
    };
    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger: opts.ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: RATE,
        freeActiveMinutesPerMonth: opts.freeAllowance,
      },
    });
    expect(out.status).toBe("succeeded");
    return out;
  }

  it("within the free allowance: no active-minute charge, usage incremented", async () => {
    const ledger = new TrackingLedger();
    const out = await runWith({ ledger, activeMin: 10, freeAllowance: FREE, runId: "run-a" });
    expect(out.spentActiveMinuteCents).toBe(0);
    // The hold is still settled (with 0) — releases the up-front overshoot.
    const settle = ledger.settles.find((s) => s.sourceRef === "auto-active-run-a")!;
    expect(settle.cents).toBe(0);
    // Usage depleted by the run's whole active-minutes.
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(10);
  });

  it("straddling the boundary: only the minutes past the allowance are billed", async () => {
    const ledger = new TrackingLedger();
    // First run uses 55 of the 60 free minutes (no charge).
    const first = await runWith({ ledger, activeMin: 55, freeAllowance: FREE, runId: "run-a" });
    expect(first.spentActiveMinuteCents).toBe(0);
    // Second run is 12 minutes: 5 free remaining + 7 billable * 1¢ = 7¢.
    const second = await runWith({ ledger, activeMin: 12, freeAllowance: FREE, runId: "run-b" });
    expect(second.spentActiveMinuteCents).toBe(7 * RATE);
    expect(ledger.settles.some((s) => s.sourceRef === "auto-active-run-b" && s.cents === 7)).toBe(true);
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(67);
  });

  it("allowance exhausted: the whole run is billed", async () => {
    const ledger = new TrackingLedger();
    await runWith({ ledger, activeMin: 60, freeAllowance: FREE, runId: "run-a" }); // exhaust
    const out = await runWith({ ledger, activeMin: 8, freeAllowance: FREE, runId: "run-b" });
    expect(out.spentActiveMinuteCents).toBe(8 * RATE);
  });

  it("NO calendar-month reset: the trial is one-time, ever (fixed lifetime key)", async () => {
    const ledger = new TrackingLedger();
    await runWith({ ledger, activeMin: 60, freeAllowance: FREE, runId: "run-jun", baseIso: "2026-06-18T00:00:00.000Z" }); // trial exhausted in June
    const july = await runWith({ ledger, activeMin: 10, freeAllowance: FREE, runId: "run-jul", baseIso: "2026-07-02T00:00:00.000Z" });
    expect(july.spentActiveMinuteCents).toBe(10 * RATE); // July does NOT start fresh
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(70);
  });

  it("freeActiveMinutesPerMonth 0 (no free tier) bills every minute, same as Slice 1", async () => {
    const ledger = new TrackingLedger();
    const out = await runWith({ ledger, activeMin: 4, freeAllowance: 0, runId: "run-a" });
    expect(out.spentActiveMinuteCents).toBe(4 * RATE);
  });

  it("re-settling the same run is idempotent (no double-deplete, same billable)", async () => {
    // The run-driver settles once per run instance; a worker RETRY re-runs the
    // ledger depletion for the same runId. The ledger keys on runId, so the
    // second application replays the first result and does not bump usage again.
    const ledger = new TrackingLedger();
    await runWith({ ledger, activeMin: 70, freeAllowance: FREE, runId: "run-r" }); // 60 free + 10 billable
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(70);
    const replay = await ledger.consumeFreeActiveMinutes("u1", FREE_TRIAL_PERIOD_KEY, 70, FREE, "run-r");
    expect(replay).toBe(10); // same billable as the first application
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(70); // unchanged
  });

  it("passes the run id and the FIXED trial key to the ledger for per-run idempotent depletion", async () => {
    const ledger = new TrackingLedger();
    await runWith({ ledger, activeMin: 3, freeAllowance: FREE, runId: "run-x", baseIso: "2026-06-18T00:00:00.000Z" });
    const call = ledger.consumeFreeCalls.find((c) => c.runId === "run-x")!;
    expect(call).toBeDefined();
    expect(call.runActiveMinutes).toBe(3);
    expect(call.freeAllowance).toBe(FREE);
    expect(call.yearMonth).toBe(FREE_TRIAL_PERIOD_KEY);
  });
});

describe("Auto v2 billing: truly-free trial (grace at run start)", () => {
  const RATE = 1; // cents/min
  const FREE = 60; // free minutes/month

  /** Like the Slice-2 runner but with the INVOCATION fee active, so the grace
   *  waiver is observable. `depleteAtTurn` simulates a CONCURRENT run eating
   *  the whole allowance between this run's start and its settle. */
  async function runWith(opts: {
    ledger: TrackingLedger;
    activeMin: number;
    runId: string;
    budgetCents: number;
    depleteAtTurn?: boolean;
  }) {
    const baseMs = Date.parse("2026-06-18T00:00:00.000Z");
    const { runs, workspace, run } = await setup({ budgetCents: opts.budgetCents, inferenceMode: "byo" });
    run.id = opts.runId;
    const clock = makeClock(baseMs);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const provider = new FakeChatProvider([textResponse("done")]);
    const origSend = provider.sendMessage.bind(provider);
    provider.sendMessage = async (req) => {
      clock.advanceMinutes(opts.activeMin);
      if (opts.depleteAtTurn) opts.ledger.freeUsage.set(`u1\x00${FREE_TRIAL_PERIOD_KEY}`, FREE);
      return origSend(req);
    };
    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger: opts.ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: INVOCATION, activeMinuteRateCents: RATE,
        freeActiveMinutesPerMonth: FREE,
      },
    });
    expect(out.status).toBe("succeeded");
    return out;
  }

  it("free minutes remaining: invocation WAIVED + hold shrunk by the allowance", async () => {
    const ledger = new TrackingLedger();
    // budget 100 → estimatedMin 100; grace 60 → hold (100-60)*1 = 40.
    const out = await runWith({ ledger, activeMin: 10, runId: "run-g1", budgetCents: 100 });
    expect(ledger.debits.filter((d) => d.sourceRef === "auto-invocation-run-g1")).toHaveLength(0);
    expect(out.spentInvocationCents).toBe(0);
    expect(ledger.reserves).toEqual([{ cents: 40 }]);
    // Within the allowance → settle 0; usage still depletes.
    expect(ledger.settles.find((s) => s.sourceRef === "auto-active-run-g1")!.cents).toBe(0);
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(10);
    expect(out.spentActiveMinuteCents).toBe(0);
  });

  it("allowance exhausted: invocation debited + full budget-derived hold (legacy path)", async () => {
    const ledger = new TrackingLedger();
    ledger.freeUsage.set(`u1\x00${FREE_TRIAL_PERIOD_KEY}`, FREE); // month already spent
    const out = await runWith({ ledger, activeMin: 10, runId: "run-g2", budgetCents: 100 });
    expect(ledger.debits.filter((d) => d.sourceRef === "auto-invocation-run-g2")).toEqual([
      { cents: INVOCATION, description: "Auto run invocation fee", sourceRef: "auto-invocation-run-g2" },
    ]);
    expect(out.spentInvocationCents).toBe(INVOCATION);
    expect(ledger.reserves).toEqual([{ cents: 100 }]);
    expect(out.spentActiveMinuteCents).toBe(10);
  });

  it("grace covers the whole estimate: NO hold reserved, yet the allowance still depletes", async () => {
    const ledger = new TrackingLedger();
    // budget 30 → estimatedMin 30 ≤ 60 free → holdCents 0 (a $0-balance user runs).
    const out = await runWith({ ledger, activeMin: 5, runId: "run-g3", budgetCents: 30 });
    expect(ledger.reserves).toHaveLength(0);
    expect(ledger.settles.filter((s) => s.sourceRef === "auto-active-run-g3")).toHaveLength(0);
    // The metering MUST still run — otherwise the free tier would be infinite.
    expect(ledger.consumeFreeCalls.map((c) => c.runId)).toContain("run-g3");
    expect(await ledger.getFreeMinutesUsed("u1", FREE_TRIAL_PERIOD_KEY)).toBe(5);
    expect(out.spentActiveMinuteCents).toBe(0);
  });

  it("concurrent depletion race: billable beyond the shrunk hold is debited via auto-active-extra", async () => {
    const ledger = new TrackingLedger();
    // Hold sized with grace 60 → 40¢; a concurrent run then eats the allowance,
    // so all 50 active-minutes bill: settle caps at the 40¢ hold + 10¢ extra debit.
    const out = await runWith({ ledger, activeMin: 50, runId: "run-g4", budgetCents: 100, depleteAtTurn: true });
    expect(ledger.reserves).toEqual([{ cents: 40 }]);
    expect(ledger.settles.find((s) => s.sourceRef === "auto-active-run-g4")!.cents).toBe(40);
    expect(ledger.debits.filter((d) => d.sourceRef === "auto-active-extra-run-g4")).toEqual([
      { cents: 10, description: "Auto run active-minutes (beyond hold)", sourceRef: "auto-active-extra-run-g4" },
    ]);
    expect(out.spentActiveMinuteCents).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// M6 P1: PREMIUM (per-invocation) royalty split
// ---------------------------------------------------------------------------
//
// The seller-set per-run royalty is metered from the BUYER's hold and accrued to
// the SELLING org — but ONLY on a BILLABLE terminal state (succeeded |
// budget_exceeded | canceled). On 'failed' the royalty rides the hold release:
// NOT debited from the buyer, NOT accrued to the seller. Everything is inert when
// premiumRoyaltyCents is 0 (the whole existing suite above proves that).

describe("Auto v2 billing: premium (per-invocation) royalty split", () => {
  const ROYALTY = 20; // cents, seller-set per-run price
  const ORG = "seller-org";
  const KIT = "premium-kit";

  /** Run a premium kit. `provider` scripts the model turns; `fail` uses an empty
   *  provider so the run FAILS. Returns { out, ledger }. */
  async function runPremium(opts: {
    inferenceMode?: InferenceMode;
    activeMinuteRateCents?: number;
    commissionBps?: number;
    fail?: boolean;
    runId?: string;
    budgetCents?: number;
    ledger?: TrackingLedger;
  }) {
    const ledger = opts.ledger ?? new TrackingLedger();
    const { runs, workspace, run } = await setup({
      budgetCents: opts.budgetCents ?? 100_000,
      inferenceMode: opts.inferenceMode ?? "byo",
    });
    if (opts.runId) run.id = opts.runId;
    const clock = makeClock();
    const provider = new FakeChatProvider(opts.fail ? [] : [textResponse("done")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const out = await runAutoRun({
      run,
      approval: APPROVAL,
      systemPrompt: "sys",
      tools: [],
      executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: opts.inferenceMode ?? "byo", maxTokens: 100,
        invocationFeeCents: 0,
        activeMinuteRateCents: opts.activeMinuteRateCents ?? 0,
        premiumRoyaltyCents: ROYALTY,
        royaltyOrgId: ORG,
        royaltyKitId: KIT,
        ...(opts.commissionBps !== undefined ? { royaltyCommissionBps: opts.commissionBps } : {}),
      },
    });
    return { out, ledger };
  }

  it("BILLABLE (succeeded): buyer settled the royalty AND the seller is accrued", async () => {
    const { out, ledger } = await runPremium({ runId: "run-p1" });
    expect(out.status).toBe("succeeded");
    // Up-front hold covers the royalty (no active-minute fee here).
    expect(ledger.reserves).toEqual([{ cents: ROYALTY }]);
    // Settled from the hold with the full royalty.
    const settle = ledger.settles.find((s) => s.sourceRef === "auto-active-run-p1")!;
    expect(settle.cents).toBe(ROYALTY);
    // Buyer receipt: royalty is its own line, folded into spentCents (NOT compute).
    expect(out.spentRoyaltyCents).toBe(ROYALTY);
    expect(out.spentComputeCents).toBe(0);
    expect(out.spentCents).toBe(ROYALTY);
    // Seller accrued once, with the gross + commission passed through.
    expect(ledger.accruals).toHaveLength(1);
    expect(ledger.accruals[0]).toMatchObject({
      orgId: ORG, kitId: KIT, runId: "run-p1", grossRoyaltyCents: ROYALTY, commissionBps: 0,
    });
  });

  it("FAILED: hold RELEASED, NO royalty debit, NO accrue", async () => {
    const { out, ledger } = await runPremium({ runId: "run-p2", fail: true });
    expect(out.status).toBe("failed");
    // The up-front hold was reserved...
    expect(ledger.reserves).toEqual([{ cents: ROYALTY }]);
    // ...and settled with 0 (releasing the whole royalty back to the buyer).
    const settle = ledger.settles.find((s) => s.sourceRef === "auto-active-run-p2")!;
    expect(settle.cents).toBe(0);
    // No royalty charged to the buyer, no extra debit.
    expect(out.spentRoyaltyCents).toBe(0);
    expect(out.spentCents).toBe(0);
    expect(ledger.debits).toHaveLength(0);
    // Seller NOT accrued.
    expect(ledger.accruals).toHaveLength(0);
  });

  it("BILLABLE (canceled) still charges + accrues the royalty", async () => {
    // Cancel mid-flight via a tool round; the run ends 'canceled' (billable).
    // Keep the default run id ("run-1") — the InMemoryRunRepo keys the run at
    // seed time, so a post-setup id reassignment would break requestCancel.
    const ledger = new TrackingLedger();
    const { runs, workspace, run } = await setup({ budgetCents: 100_000, inferenceMode: "byo" });
    const clock = makeClock();
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "a.txt", content: "x" }),
      textResponse("unreached"),
    ]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, resolvedTools: ["write_file"], now: clock.now });
    const exec2 = async (tu: Parameters<typeof exec>[0]) => {
      await runs.requestCancel(run.id);
      return exec(tu);
    };
    const out = await runAutoRun({
      run, approval: APPROVAL, systemPrompt: "sys",
      tools: [{ name: "write_file", description: "", inputSchema: {} }],
      executeTool: exec2,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: 0,
        premiumRoyaltyCents: ROYALTY, royaltyOrgId: ORG, royaltyKitId: KIT,
      },
    });
    expect(out.status).toBe("canceled");
    expect(out.spentRoyaltyCents).toBe(ROYALTY);
    expect(ledger.accruals).toHaveLength(1);
  });

  it("applies the commission: the gross+bps are passed to the seller accrual (net computed by the ledger)", async () => {
    const { out, ledger } = await runPremium({ runId: "run-p4", commissionBps: 600 });
    expect(out.status).toBe("succeeded");
    // The BUYER pays the full gross royalty (commission is withheld at PAYOUT, not
    // from the buyer).
    expect(out.spentRoyaltyCents).toBe(ROYALTY);
    expect(ledger.accruals[0]).toMatchObject({ grossRoyaltyCents: ROYALTY, commissionBps: 600 });
  });

  it("royalty rides on TOP of the active-minute fee in one hold", async () => {
    const RATE = 5; // cents/min
    const ledger = new TrackingLedger();
    const { runs, workspace, run } = await setup({ budgetCents: 100, inferenceMode: "byo" }); // estMin=ceil(100/5)=20
    run.id = "run-p5";
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("done")]);
    const origSend = provider.sendMessage.bind(provider);
    provider.sendMessage = async (req) => { clock.advanceMinutes(2); return origSend(req); };
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const out = await runAutoRun({
      run, approval: APPROVAL, systemPrompt: "sys", tools: [], executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: RATE,
        premiumRoyaltyCents: ROYALTY, royaltyOrgId: ORG, royaltyKitId: KIT,
      },
    });
    expect(out.status).toBe("succeeded");
    // Hold = estMin*RATE (100) + royalty (20) = 120.
    expect(ledger.reserves).toEqual([{ cents: 120 }]);
    // Settle = ceil(2)*RATE (10) + royalty (20) = 30.
    const settle = ledger.settles.find((s) => s.sourceRef === "auto-active-run-p5")!;
    expect(settle.cents).toBe(30);
    expect(out.spentActiveMinuteCents).toBe(10);
    expect(out.spentRoyaltyCents).toBe(ROYALTY);
    expect(out.spentComputeCents).toBe(10); // compute = active-minute only (royalty separate)
    expect(out.spentCents).toBe(30); // inference 0 (byo) + compute 10 + royalty 20
    expect(ledger.accruals).toHaveLength(1);
  });

  it("retry is idempotent: re-accruing the same runId accrues once (ledger-keyed)", async () => {
    const ledger = new TrackingLedger();
    await runPremium({ runId: "run-p6", ledger });
    expect(ledger.accruals).toHaveLength(1);
    // A worker RETRY re-invokes accrueRoyalty for the same runId.
    await ledger.accrueRoyalty({ orgId: ORG, kitId: KIT, runId: "run-p6", grossRoyaltyCents: ROYALTY, commissionBps: 0, now: "2026-07-04T00:00:00.000Z" });
    expect(ledger.accruals).toHaveLength(1); // still one
  });

  it("premiumRoyaltyCents 0 → byte-identical to a non-premium run (no hold, no settle, no accrue)", async () => {
    const ledger = new TrackingLedger();
    const { runs, workspace, run } = await setup({ budgetCents: 1_000_000, inferenceMode: "byo" });
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("done")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const out = await runAutoRun({
      run, approval: APPROVAL, systemPrompt: "sys", tools: [], executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: 0,
        premiumRoyaltyCents: 0, royaltyOrgId: ORG, royaltyKitId: KIT, // 0 → inert regardless of org/kit
      },
    });
    expect(out.status).toBe("succeeded");
    expect(ledger.reserves).toHaveLength(0);
    expect(ledger.settles).toHaveLength(0);
    expect(ledger.debits).toHaveLength(0);
    expect(ledger.accruals).toHaveLength(0);
    expect(out.spentRoyaltyCents).toBe(0);
    expect(out.spentCents).toBe(0);
  });

  it("missing royaltyOrgId/kitId with a positive royalty → inert (never accrues to an empty org)", async () => {
    const ledger = new TrackingLedger();
    const { runs, workspace, run } = await setup({ budgetCents: 1_000_000, inferenceMode: "byo" });
    const clock = makeClock();
    const provider = new FakeChatProvider([textResponse("done")]);
    const exec = makeSandboxExecutor({ workspace, workspaceId: run.workspaceId!, runId: run.id, approval: APPROVAL, repo: runs, now: clock.now });
    const out = await runAutoRun({
      run, approval: APPROVAL, systemPrompt: "sys", tools: [], executeTool: exec,
      deps: {
        chatProvider: provider, ledger, runs, workspace, now: clock.now,
        inferenceMode: "byo", maxTokens: 100,
        invocationFeeCents: 0, activeMinuteRateCents: 0,
        premiumRoyaltyCents: ROYALTY, // but no royaltyOrgId / royaltyKitId
      },
    });
    expect(out.status).toBe("succeeded");
    expect(ledger.reserves).toHaveLength(0);
    expect(ledger.accruals).toHaveLength(0);
    expect(out.spentRoyaltyCents).toBe(0);
  });
});
