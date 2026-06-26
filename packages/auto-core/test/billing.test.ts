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
import { computeDebitCents, type CreditLedgerRepository } from "@agentkitforge/gateway-core";
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
