/**
 * Worker FAILURE SEMANTICS — handled vs unhandled failures and the exit-code
 * contract (k8s Job / Fargate: backoffLimit 0, so the exit code only decides
 * whether the Job reads Complete or Failed → whether KubeJobFailed fires).
 *
 * What is asserted:
 *   - HANDLED failure (terminal `failed` recorded) → `main()` EXITS 0, so a
 *     kit-deleted / approval-denied / driver-failed run never raises the
 *     operator's KubeJobFailed alert;
 *   - up-front resolve-context failure with a REACHABLE API (the exact live
 *     gamma incident: kit deleted between dispatch and Job start → HTTP 404)
 *     best-effort marks the run FAILED before exiting (no zombie `queued` run);
 *   - UNRECORDABLE failure (the terminal-status write itself fails, or an
 *     untyped crash) → `main()` exits NON-ZERO (the alert stays meaningful);
 *   - `processAutoRun`'s resolve-hook failure path throws the TYPED
 *     HandledRunFailureError after recording `failed` — and re-throws the
 *     ORIGINAL error when the record write fails.
 *
 * Style matches worker-execution / approval-gate: fake stores + injected fetch,
 * zero network, zero real spend.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalDeniedError,
  HandledRunFailureError,
  processAutoRun,
  type ProcessAutoRunDeps,
} from "../src/entrypoints/worker.js";
import { main, resolveContextOrFailRun } from "../src/entrypoints/run-task.js";
import type { AutoStorageDeps } from "../src/core/ports.js";
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
import type { CreditLedgerRepository } from "@agentkitforge/gateway-core";

// ---------------------------------------------------------------------------
// Shared fakes (worker-execution style)
// ---------------------------------------------------------------------------

/** Always-funded no-op ledger — failure semantics never touch billing here. */
const inertLedger: CreditLedgerRepository = {
  async getAccount() {
    return account();
  },
  async ensureAccount() {
    return account();
  },
  async recordTransaction() {
    return { transactionId: "t", userId: "u1", type: "debit" as const, amountCents: 0, createdAt: noopNow() };
  },
  async topup() {
    return account();
  },
  async debit() {
    return account();
  },
  async reserveHold() {
    return "h-1";
  },
  async settleHold() {
    return account();
  },
  async releaseHold() {
    return account();
  },
  async getHold() {
    return undefined;
  },
  async listTransactions() {
    return [];
  },
  async getFreeMinutesUsed() {
    return 0;
  },
  async consumeFreeActiveMinutes(_u: string, _ym: string, mins: number) {
    return mins;
  },
};

function account() {
  return {
    userId: "u1",
    availableBalanceCents: 1_000_000,
    heldBalanceCents: 0,
    lifetimeTopupCents: 0,
    updatedAt: noopNow(),
  };
}

function buildStorage() {
  const runs = new InMemoryRunRepo();
  const approvals = new InMemoryApprovalRepo();
  const workspaces = new InMemoryWorkspace();
  const storage: AutoStorageDeps = {
    runs,
    approvals,
    workspaces,
    schedules: new InMemoryScheduleRepo(),
    webhooks: new InMemoryWebhookRepo(),
    inputs: new LocalInputStore(),
  };
  return { runs, approvals, storage };
}

const KIT_REF = { source: "local", localKitId: "k1" } as const;

async function seedApprovedRun(runs: InMemoryRunRepo, approvals: InMemoryApprovalRepo) {
  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT_REF,
    toolAllowlist: ["read_file"],
    maxBudgetCents: 1_000_000,
    createdAt: noopNow(),
  });
  return runs.createRun({
    userId: "u1",
    kitRef: KIT_REF,
    input: { prompt: "do the task" },
    budgetCents: 100_000,
    model: "claude-sonnet-4-6",
    createdAt: noopNow(),
  });
}

/** A fetch stub returning a fixed HTTP status with no body access. */
function httpStatusFetch(status: number): typeof fetch {
  return (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => ({}) })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveContextOrFailRun — the up-front fetch gap (kit deleted → HTTP 404)
// ---------------------------------------------------------------------------

describe("resolveContextOrFailRun (up-front resolve fetch)", () => {
  it("marks the run FAILED and throws HandledRunFailureError on HTTP 404 (kit deleted, API reachable)", async () => {
    const { runs, approvals } = buildStorage();
    const run = await seedApprovedRun(runs, approvals);

    await expect(
      resolveContextOrFailRun({
        runId: run.id,
        baseUrl: "http://forge.internal",
        serviceKey: "sk",
        runs,
        now: noopNow,
        fetchImpl: httpStatusFetch(404),
      }),
    ).rejects.toBeInstanceOf(HandledRunFailureError);

    // The run is terminal — never a zombie `queued` row in the UI.
    const persisted = await runs.getRun(run.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.error).toMatch(/run context unavailable \(kit deleted\?\)/);
    expect(persisted?.error).toMatch(/HTTP 404/);
    expect(persisted?.finishedAt).toBe(noopNow());
  });

  it("re-throws the ORIGINAL fetch error (not Handled) when even the failed-status write fails", async () => {
    const { runs, approvals } = buildStorage();
    const run = await seedApprovedRun(runs, approvals);
    const brokenRuns = {
      updateRunStatus: async () => {
        throw new Error("storage down");
      },
    };

    // Original resolve error surfaces UNTYPED → main() maps it to exit 1.
    await expect(
      resolveContextOrFailRun({
        runId: run.id,
        baseUrl: "http://forge.internal",
        serviceKey: "sk",
        runs: brokenRuns,
        now: noopNow,
        fetchImpl: httpStatusFetch(404),
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof HandledRunFailureError) &&
        /resolve-context failed: HTTP 404/.test(e.message),
    );
  });

  it("passes the payload through untouched on success (no status write)", async () => {
    const { runs, approvals } = buildStorage();
    const run = await seedApprovedRun(runs, approvals);
    const payload = { tools: [], toolNames: [], inferenceMode: "managed" as const };
    const okFetch = (async () =>
      ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch;

    const got = await resolveContextOrFailRun({
      runId: run.id,
      baseUrl: "http://forge.internal",
      serviceKey: "sk",
      runs,
      now: noopNow,
      fetchImpl: okFetch,
    });

    expect(got.inferenceMode).toBe("managed");
    expect((await runs.getRun(run.id))?.status).toBe("queued"); // untouched
  });
});

// ---------------------------------------------------------------------------
// processAutoRun — resolve-hook failure records `failed` and throws TYPED
// ---------------------------------------------------------------------------

describe("processAutoRun resolve-hook failure typing", () => {
  function depsFor(storage: AutoStorageDeps, resolveKitContext: ProcessAutoRunDeps["resolveKitContext"]) {
    return {
      storage,
      chatProvider: new FakeChatProvider([textResponse("SHOULD NOT BE CALLED")]),
      ledger: inertLedger,
      resolveKitContext,
      now: noopNow,
    } satisfies ProcessAutoRunDeps;
  }

  it("throws HandledRunFailureError (cause = original) after recording the run failed", async () => {
    const { runs, approvals, storage } = buildStorage();
    const run = await seedApprovedRun(runs, approvals);
    const original = new Error("resolve-context failed: HTTP 404");

    const err = await processAutoRun(
      run.id,
      depsFor(storage, async () => {
        throw original;
      }),
    ).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(HandledRunFailureError);
    expect((err as Error).message).toMatch(/HTTP 404/);
    expect((err as Error).cause).toBe(original);
    expect((await runs.getRun(run.id))?.status).toBe("failed");
  });

  it("re-throws the ORIGINAL resolver error when the failed-status write fails (unhandled)", async () => {
    const { runs, approvals, storage } = buildStorage();
    const run = await seedApprovedRun(runs, approvals);
    const original = new Error("resolver blew up");
    // Approval-gate reads work; the resolve-failure write is the one that dies.
    const update = vi.spyOn(runs, "updateRunStatus").mockRejectedValue(new Error("storage down"));

    await expect(
      processAutoRun(
        run.id,
        depsFor(storage, async () => {
          throw original;
        }),
      ),
    ).rejects.toBe(original);
    expect(update).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// main() — exit-code contract (backoffLimit 0: Complete vs Failed only)
// ---------------------------------------------------------------------------

describe("main() exit-code contract", () => {
  function spyExit() {
    return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  }

  it("HANDLED failure (terminal `failed` recorded) → exit 0 (no process.exit)", async () => {
    const exit = spyExit();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(async () => {
      throw new HandledRunFailureError("Auto run r1 finished: failed");
    });

    expect(exit).not.toHaveBeenCalled(); // clean return → Job reads Complete
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("handled"));
  });

  it("ApprovalDeniedError (recorded by denyAndFail before the throw) → exit 0", async () => {
    const exit = spyExit();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(async () => {
      throw new ApprovalDeniedError("No standing approval exists for this kit.");
    });

    expect(exit).not.toHaveBeenCalled();
  });

  it("UNRECORDABLE failure (untyped error — crash / status write failed) → exit 1", async () => {
    const exit = spyExit();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await main(async () => {
      throw new Error("resolve-context failed: HTTP 404"); // no failed-write happened
    });

    expect(exit).toHaveBeenCalledWith(1); // Job reads Failed → KubeJobFailed fires (meaningful)
  });

  it("clean terminal statuses → exit 0", async () => {
    const exit = spyExit();
    await main(async () => {});
    expect(exit).not.toHaveBeenCalled();
  });
});
