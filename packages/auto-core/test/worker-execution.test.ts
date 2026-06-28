/**
 * Worker EXECUTION path — end to end, fully MOCKED (no real Anthropic spend).
 *
 * This is the run-execution increment's coverage: it proves that the function a
 * dispatched k8s Job / Fargate task ultimately invokes — `processAutoRun` — drives
 * a queued run to completion against a MOCKED ChatProvider, recording spend and a
 * terminal status, exactly as the real worker (`run-task.ts` → `processAutoRun`)
 * would, but with ZERO real inference.
 *
 * It also exercises `toResolveKitContext` — the exact adapter `run-task.ts` uses to
 * turn the HTTP resolve-context payload into the `resolveKitContext` hook — so the
 * shape the worker feeds `processAutoRun` is covered too.
 *
 * What is asserted:
 *   - a no-tool run completes "succeeded", persists the result, and the provider
 *     was called exactly once (managed turn) with NO real network;
 *   - a tool_use round drives the sandbox executor (write_file) then completes,
 *     and the produced file is bundled into the result;
 *   - managed-mode inference debits the ledger (spend recorded on the run);
 *   - BYO mode calls the provider directly and never debits inference;
 *   - the resolve-context payload adapter feeds systemPrompt + tools through.
 */

import { describe, expect, it } from "vitest";
import {
  processAutoRun,
  type ProcessAutoRunDeps,
} from "../src/entrypoints/worker.js";
import { toResolveKitContext } from "../src/core/http-resolve-context.js";
import type { AutoStorageDeps } from "../src/core/ports.js";
import type { CreditLedgerRepository } from "@agentkitforge/gateway-core";
import {
  FakeChatProvider,
  InMemoryRunRepo,
  InMemoryWorkspace,
  noopNow,
  textResponse,
  toolUseResponse,
} from "./fakes.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { InMemoryScheduleRepo } from "./schedule-repo-fake.js";
import { InMemoryWebhookRepo } from "./webhook-repo-fake.js";
import { LocalInputStore } from "../src/core/input-store.js";

/**
 * A ledger that RECORDS settled debits so the managed-billing assertion can prove
 * inference was metered. Mirrors gateway-core's two-phase hold shape; always
 * funded so the run is never blocked on balance.
 */
class RecordingLedger implements CreditLedgerRepository {
  settled: number[] = [];
  private seq = 0;
  private account() {
    return {
      userId: "u1",
      availableBalanceCents: 1_000_000,
      heldBalanceCents: 0,
      lifetimeTopupCents: 0,
      updatedAt: noopNow(),
    };
  }
  async getAccount() {
    return this.account();
  }
  async ensureAccount() {
    return this.account();
  }
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: noopNow() };
  }
  async topup() {
    return this.account();
  }
  async debit() {
    return this.account();
  }
  async reserveHold() {
    return `h-${++this.seq}`;
  }
  async settleHold(_holdId: string, costCents: number) {
    this.settled.push(costCents);
    return this.account();
  }
  async releaseHold() {
    return this.account();
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
  async consumeFreeActiveMinutes(
    _userId: string,
    _yearMonth: string,
    runActiveMinutes: number,
  ) {
    return runActiveMinutes;
  }
}

function buildStorage() {
  const runs = new InMemoryRunRepo();
  const approvals = new InMemoryApprovalRepo();
  const workspaces = new InMemoryWorkspace();
  const schedules = new InMemoryScheduleRepo();
  const webhooks = new InMemoryWebhookRepo();
  const inputs = new LocalInputStore();
  const storage: AutoStorageDeps = { runs, approvals, workspaces, schedules, webhooks, inputs };
  return { runs, approvals, workspaces, storage };
}

const KIT_REF = { source: "local", localKitId: "k1" } as const;

async function seedApprovedRun(
  runs: InMemoryRunRepo,
  approvals: InMemoryApprovalRepo,
  opts: { budgetCents?: number; inferenceMode?: "managed" | "byo" } = {},
) {
  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT_REF,
    toolAllowlist: ["read_file", "list_dir", "write_file"],
    maxBudgetCents: 1_000_000,
    createdAt: noopNow(),
  });
  return runs.createRun({
    userId: "u1",
    kitRef: KIT_REF,
    input: { prompt: "do the task" },
    budgetCents: opts.budgetCents ?? 100_000,
    model: "claude-sonnet-4-6",
    createdAt: noopNow(),
    ...(opts.inferenceMode ? { inferenceMode: opts.inferenceMode } : {}),
  });
}

describe("worker execution path (processAutoRun, mocked Anthropic — no real spend)", () => {
  it("runs a no-tool managed run to 'succeeded', records spend, calls provider once", async () => {
    const { runs, approvals, storage } = buildStorage();
    const run = await seedApprovedRun(runs, approvals, { inferenceMode: "managed" });

    const provider = new FakeChatProvider([textResponse("all done")]);
    const ledger = new RecordingLedger();
    const deps: ProcessAutoRunDeps = {
      storage,
      chatProvider: provider,
      ledger,
      inferenceMode: "managed",
      // The exact adapter run-task.ts uses to turn the resolve-context HTTP
      // payload into the resolveKitContext hook.
      resolveKitContext: toResolveKitContext({
        systemPrompt: "You are a kit.",
        tools: [],
        toolNames: [],
        inferenceMode: "managed",
      }),
      now: noopNow,
      markupBps: 2500,
    };

    const result = await processAutoRun(run.id, deps);

    expect(result.status).toBe("succeeded");
    expect(provider.calls).toBe(1); // exactly one model turn, fully mocked
    const persisted = await runs.getRun(run.id);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.result?.output).toBe("all done");
    // Managed mode debited the ledger (metered inference settled at least once).
    expect(ledger.settled.length).toBeGreaterThanOrEqual(1);
    expect(persisted?.spentCents).toBeGreaterThan(0);
  });

  it("drives a tool_use round (write_file) then completes, bundling the file", async () => {
    const { runs, approvals, storage } = buildStorage();
    const run = await seedApprovedRun(runs, approvals, { inferenceMode: "managed" });

    // Turn 1: the model writes a file via the sandbox tool. Turn 2: it finishes.
    const provider = new FakeChatProvider([
      toolUseResponse("write_file", { path: "out.txt", content: "hello" }),
      textResponse("wrote the file"),
    ]);
    const deps: ProcessAutoRunDeps = {
      storage,
      chatProvider: provider,
      ledger: new RecordingLedger(),
      inferenceMode: "managed",
      resolveKitContext: toResolveKitContext({
        systemPrompt: "You are a kit.",
        tools: [
          { name: "write_file", description: "", inputSchema: { type: "object" } },
        ],
        toolNames: ["write_file"],
        inferenceMode: "managed",
      }),
      now: noopNow,
      markupBps: 2500,
    };

    const result = await processAutoRun(run.id, deps);

    expect(result.status).toBe("succeeded");
    expect(result.toolRounds).toBe(1);
    expect(provider.calls).toBe(2);
    const persisted = await runs.getRun(run.id);
    // The file the sandbox executor wrote is bundled into the result manifest.
    expect(persisted?.result?.files.some((f) => f.path === "out.txt")).toBe(true);
  });

  it("marks the run FAILED (not stuck 'queued') when kit-context resolution throws (M6: lost entitlement)", async () => {
    // A PROTECTED Market kit whose buyer is no longer entitled: the injected
    // resolveKitContext hook throws (the real one surfaces the Market 403). The
    // worker must record the run as terminal-FAILED and re-throw — never leave it
    // stuck "queued" (which would never settle / could be re-picked by a retry).
    const { runs, approvals, storage } = buildStorage();
    const run = await seedApprovedRun(runs, approvals, { inferenceMode: "managed" });

    const provider = new FakeChatProvider([textResponse("SHOULD NOT BE CALLED")]);
    const deps: ProcessAutoRunDeps = {
      storage,
      chatProvider: provider,
      ledger: new RecordingLedger(),
      inferenceMode: "managed",
      resolveKitContext: async () => {
        throw new Error("The user is not entitled to this protected kit.");
      },
      now: noopNow,
      markupBps: 2500,
    };

    await expect(processAutoRun(run.id, deps)).rejects.toThrow(/not entitled/i);
    // No inference ran and no result was produced.
    expect(provider.calls).toBe(0);
    const persisted = await runs.getRun(run.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.result).toBeUndefined();
  });

  it("BYO mode calls the provider directly and never debits inference", async () => {
    const { runs, approvals, storage } = buildStorage();
    const run = await seedApprovedRun(runs, approvals, { inferenceMode: "byo" });

    const byoProvider = new FakeChatProvider([textResponse("byo done")]);
    const ledger = new RecordingLedger();
    const deps: ProcessAutoRunDeps = {
      storage,
      // chatProvider is the managed provider; in BYO mode byoChatProvider is used.
      chatProvider: new FakeChatProvider([textResponse("SHOULD NOT BE CALLED")]),
      byoChatProvider: byoProvider,
      ledger,
      inferenceMode: "byo",
      resolveKitContext: toResolveKitContext({
        systemPrompt: "You are a kit.",
        tools: [],
        toolNames: [],
        inferenceMode: "byo",
      }),
      now: noopNow,
    };

    const result = await processAutoRun(run.id, deps);

    expect(result.status).toBe("succeeded");
    expect(byoProvider.calls).toBe(1); // BYO provider used
    expect(ledger.settled).toEqual([]); // NO inference debit in BYO mode
    expect(result.spentInferenceCents).toBe(0);
    const persisted = await runs.getRun(run.id);
    expect(persisted?.result?.output).toBe("byo done");
  });
});
