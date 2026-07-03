/**
 * run_completed-poller tests (Wave 3b — kit chaining): baseline-first-sweep
 * (pre-existing terminal runs never fire), status/kitRef/sourceTriggerId
 * config matching, tie-safe no-dupe across sweeps (hwm + seen cursor,
 * persist-before-dispatch), the per-sweep cap, chain-depth propagation onto
 * the created run's input.event, and the >MAX_TRIGGER_CHAIN_DEPTH refusal
 * (loop guard — no run, no circuit penalty).
 */

import { describe, expect, it } from "vitest";
import {
  chainDepthOfRun,
  MAX_TRIGGER_CHAIN_DEPTH,
  RUN_COMPLETED_MAX_EVENTS_PER_SWEEP,
  runRunCompletedPollSweep,
  type RunCompletedCursor,
  type RunCompletedPollDeps,
} from "../src/core/run-completed-poller.js";
import type {
  CreateAndDispatchTriggerRun,
  TriggerRunRequest,
} from "../src/core/trigger-runner.js";
import type { AutoRun, KitRef, Trigger } from "../src/core/types.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import {
  fakeCanStart,
  InMemoryFireLogRepo,
  InMemoryRunRepo,
  InMemoryTriggerRepo,
} from "./fakes.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const OTHER_KIT: KitRef = { source: "market", marketKitId: "mk-9", slug: "niner" };
const T0 = "2026-07-03T12:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

let runSeq = 0;
function makeRun(over: Partial<AutoRun> = {}): AutoRun {
  return {
    id: `src-run-${++runSeq}`,
    userId: "u1",
    kitRef: OTHER_KIT,
    status: "succeeded",
    input: { prompt: "do things" },
    budgetCents: 100,
    spentCents: 5,
    model: "claude-sonnet-4-6",
    createdAt: at(-10),
    finishedAt: at(-1),
    auditLog: [],
    result: { output: "All done. Report written.", files: [] },
    outputFiles: [
      { path: "report.md", sizeBytes: 12, storeKey: "auto-outputs/x/report.md" },
    ],
    ...over,
  } as AutoRun;
}

function makeChainTrigger(over: Partial<Trigger> = {}, config: Record<string, unknown> = {}): Trigger {
  return {
    id: "chain-1",
    userId: "u1",
    name: "chain next kit",
    type: "run_completed",
    config: { sourceTriggerId: null, kitRef: null, statuses: ["succeeded"], ...config },
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 200,
    mapping: {
      promptTemplate: "Follow up on run {{runId}} ({{status}}): {{summary}}",
      attachPayloadAs: "event.json",
      fileHandling: "attach",
    },
    rateLimit: { maxPerHour: 500 },
    enabled: true,
    cursor: null,
    circuit: { consecutiveFailures: 0, pausedAt: null },
    createdAt: T0,
    updatedAt: T0,
    fireCount: 0,
    ...over,
  } as Trigger;
}

function fakeDispatcher(): { fn: CreateAndDispatchTriggerRun; calls: TriggerRunRequest[] } {
  const calls: TriggerRunRequest[] = [];
  let seq = 0;
  const fn: CreateAndDispatchTriggerRun = async (req) => {
    calls.push(req);
    return {
      id: `chained-run-${++seq}`,
      userId: req.trigger.userId,
      kitRef: req.trigger.kitRef,
      status: "queued",
      input: req.input,
      budgetCents: 200,
      spentCents: 0,
      model: "claude-sonnet-4-6",
      createdAt: req.firedAt,
      auditLog: [],
    } as AutoRun;
  };
  return { fn, calls };
}

async function setup(over: { trigger?: Partial<Trigger>; config?: Record<string, unknown> } = {}) {
  const triggers = new InMemoryTriggerRepo();
  const approvals = new InMemoryApprovalRepo();
  const fireLogs = new InMemoryFireLogRepo();
  const runs = new InMemoryRunRepo();
  const dispatcher = fakeDispatcher();

  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: ["read_file"],
    maxBudgetCents: 1000,
    createdAt: T0,
  });
  const trigger = triggers.seed(makeChainTrigger(over.trigger, over.config));

  const deps: RunCompletedPollDeps = {
    triggers,
    approvals,
    fireLogs,
    canStartRun: fakeCanStart(true).fn,
    createAndDispatch: dispatcher.fn,
    runs,
  };
  return { triggers, approvals, fireLogs, runs, dispatcher, trigger, deps };
}

async function cursorOf(triggers: InMemoryTriggerRepo, id: string): Promise<RunCompletedCursor> {
  const t = await triggers.getTrigger(id);
  return JSON.parse(t!.cursor as string) as RunCompletedCursor;
}

describe("run_completed poller — baseline + matching", () => {
  it("baseline first sweep: pre-existing terminal runs never fire; later terminals fire once with the metadata payload", async () => {
    const { deps, runs, dispatcher, triggers, trigger } = await setup();
    runs.seed(makeRun({ id: "old-run", finishedAt: at(-5) }));

    const first = await runRunCompletedPollSweep(deps, at(0));
    expect(first.processed).toBe(1);
    expect(first.dispatched).toBe(0);
    expect((await cursorOf(triggers, trigger.id)).hwm).toBe(at(0));

    const source = runs.seed(makeRun({ id: "new-run", finishedAt: at(1) }));
    const second = await runRunCompletedPollSweep(deps, at(2));
    expect(second.dispatched).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
    // S1: metadata interpolated as values; prompt is the only instruction source.
    expect(dispatcher.calls[0]!.input.prompt).toBe(
      "Follow up on run new-run (succeeded): All done. Report written.",
    );
    const payload = JSON.parse(dispatcher.calls[0]!.input.files![0]!.content) as Record<string, unknown>;
    expect(payload).toEqual({
      runId: "new-run",
      kitRef: source.kitRef,
      status: "succeeded",
      chainDepth: 1,
      summary: "All done. Report written.",
      outputFiles: ["report.md"], // PATHS only — never contents
    });

    // No dupe on the next sweep.
    const third = await runRunCompletedPollSweep(deps, at(4));
    expect(third.dispatched).toBe(0);
  });

  it("status filter: a failed run fires only when 'failed' is configured", async () => {
    const onlySucceeded = await setup();
    await runRunCompletedPollSweep(onlySucceeded.deps, at(0)); // baseline
    onlySucceeded.runs.seed(makeRun({ status: "failed", finishedAt: at(1) }));
    const s1 = await runRunCompletedPollSweep(onlySucceeded.deps, at(2));
    expect(s1.dispatched).toBe(0);

    const onFailure = await setup({ config: { statuses: ["failed", "budget_exceeded"] } });
    await runRunCompletedPollSweep(onFailure.deps, at(0)); // baseline
    onFailure.runs.seed(makeRun({ status: "failed", finishedAt: at(1) }));
    onFailure.runs.seed(makeRun({ status: "succeeded", finishedAt: at(1) }));
    const s2 = await runRunCompletedPollSweep(onFailure.deps, at(2));
    expect(s2.dispatched).toBe(1);
    expect(onFailure.dispatcher.calls[0]!.input.prompt).toContain("failed");
  });

  it("kitRef filter matches market ids and local ids; sourceTriggerId scopes to one upstream trigger", async () => {
    const byKit = await setup({ config: { kitRef: { source: "market", marketKitId: "mk-9" } } });
    await runRunCompletedPollSweep(byKit.deps, at(0));
    byKit.runs.seed(makeRun({ finishedAt: at(1) })); // OTHER_KIT = mk-9 → match
    byKit.runs.seed(makeRun({ kitRef: { source: "local", localKitId: "elsewhere" }, finishedAt: at(1) }));
    const s1 = await runRunCompletedPollSweep(byKit.deps, at(2));
    expect(s1.dispatched).toBe(1);

    const byTrigger = await setup({ config: { sourceTriggerId: "upstream-7" } });
    await runRunCompletedPollSweep(byTrigger.deps, at(0));
    byTrigger.runs.seed(makeRun({ triggerId: "upstream-7", finishedAt: at(1) }));
    byTrigger.runs.seed(makeRun({ triggerId: "other-trigger", finishedAt: at(1) }));
    byTrigger.runs.seed(makeRun({ finishedAt: at(1) })); // no provenance
    const s2 = await runRunCompletedPollSweep(byTrigger.deps, at(2));
    expect(s2.dispatched).toBe(1);
  });

  it("non-terminal and unfinished runs never fire", async () => {
    const { deps, runs } = await setup();
    await runRunCompletedPollSweep(deps, at(0));
    runs.seed(makeRun({ status: "running", finishedAt: undefined as unknown as string }));
    runs.seed(makeRun({ status: "queued", finishedAt: undefined as unknown as string }));
    const summary = await runRunCompletedPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(0);
  });
});

describe("run_completed poller — no-dupe + cap", () => {
  it("tie-safe cursor: a run finishing at EXACTLY the high-water mark still fires exactly once", async () => {
    const { deps, runs, dispatcher } = await setup();
    await runRunCompletedPollSweep(deps, at(0)); // baseline
    runs.seed(makeRun({ id: "r-a", finishedAt: at(1) }));
    await runRunCompletedPollSweep(deps, at(2));
    expect(dispatcher.calls).toHaveLength(1);

    // A second run with the SAME finishedAt as the persisted hwm.
    runs.seed(makeRun({ id: "r-b", finishedAt: at(1) }));
    await runRunCompletedPollSweep(deps, at(4));
    expect(dispatcher.calls).toHaveLength(2);
    expect(dispatcher.calls[1]!.input.prompt).toContain("r-b");

    // And neither re-fires.
    const after = await runRunCompletedPollSweep(deps, at(6));
    expect(after.dispatched).toBe(0);
  });

  it("caps a sweep at RUN_COMPLETED_MAX_EVENTS_PER_SWEEP; the rest fire next sweep (no miss, no dupe)", async () => {
    const { deps, runs, dispatcher } = await setup();
    await runRunCompletedPollSweep(deps, at(0)); // baseline
    for (let i = 0; i < RUN_COMPLETED_MAX_EVENTS_PER_SWEEP + 5; i++) {
      runs.seed(makeRun({ id: `bulk-${String(i).padStart(2, "0")}`, finishedAt: at(1) }));
    }
    const second = await runRunCompletedPollSweep(deps, at(2));
    expect(second.dispatched).toBe(RUN_COMPLETED_MAX_EVENTS_PER_SWEEP);
    const third = await runRunCompletedPollSweep(deps, at(4));
    expect(third.dispatched).toBe(5);
    const ids = dispatcher.calls.map(
      (c) => (JSON.parse(c.input.files![0]!.content) as { runId: string }).runId,
    );
    expect(new Set(ids).size).toBe(RUN_COMPLETED_MAX_EVENTS_PER_SWEEP + 5);
    const fourth = await runRunCompletedPollSweep(deps, at(6));
    expect(fourth.dispatched).toBe(0);
  });

  it("persists the cursor BEFORE dispatch (a crash mid-dispatch cannot double-fire)", async () => {
    const { deps, runs, dispatcher } = await setup();
    await runRunCompletedPollSweep(deps, at(0)); // baseline
    runs.seed(makeRun({ id: "crash-run", finishedAt: at(1) }));
    const failing: RunCompletedPollDeps = {
      ...deps,
      createAndDispatch: async () => {
        throw new Error("dispatch exploded");
      },
    };
    const summary = await runRunCompletedPollSweep(failing, at(2));
    expect(summary.errors).toHaveLength(1);
    const retry = await runRunCompletedPollSweep(deps, at(4));
    expect(retry.dispatched).toBe(0); // acknowledged before dispatch — no dupe
    expect(dispatcher.calls).toHaveLength(0);
  });
});

describe("run_completed poller — chain-loop safety", () => {
  it("stamps chainDepth = source depth + 1 onto the fired event AND the created run's input.event", async () => {
    const { deps, runs, dispatcher } = await setup();
    await runRunCompletedPollSweep(deps, at(0)); // baseline
    // The source run was ITSELF chain-created at depth 1.
    runs.seed(
      makeRun({
        id: "hop-1",
        finishedAt: at(1),
        input: { prompt: "p", event: { name: "run_completed", chainDepth: 1 } },
      }),
    );
    const summary = await runRunCompletedPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(1);
    const req = dispatcher.calls[0]!;
    // The loop-guard carrier: the NEXT run's input.event carries depth 2.
    expect(req.input.event).toEqual({ name: "run_completed", chainDepth: 2 });
    const payload = JSON.parse(req.input.files![0]!.content) as { chainDepth: number };
    expect(payload.chainDepth).toBe(2);
    // And chainDepthOfRun reads it back off the created run.
    expect(chainDepthOfRun({ input: req.input } as AutoRun)).toBe(2);
  });

  it(`REFUSES a fire whose depth would exceed ${MAX_TRIGGER_CHAIN_DEPTH} (loop guard: error log, no run, no circuit penalty)`, async () => {
    const { deps, runs, dispatcher, fireLogs, triggers, trigger } = await setup();
    await runRunCompletedPollSweep(deps, at(0)); // baseline
    runs.seed(
      makeRun({
        id: "deep-run",
        finishedAt: at(1),
        input: { prompt: "p", event: { name: "run_completed", chainDepth: MAX_TRIGGER_CHAIN_DEPTH } },
      }),
    );
    const summary = await runRunCompletedPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(0);
    expect(dispatcher.calls).toHaveLength(0);
    const log = (await fireLogs.listFireLogsByTrigger(trigger.id, 1))[0];
    expect(log).toMatchObject({ outcome: "error", runId: null });
    expect(log!.detail).toContain("loop guard");
    // The guard working as designed is NOT a trigger failure.
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(0);
    // And the refused run is acknowledged — no retry storm next sweep.
    const next = await runRunCompletedPollSweep(deps, at(4));
    expect(next.dispatched).toBe(0);
    expect((await fireLogs.listFireLogsByTrigger(trigger.id, 10)).length).toBe(1);
  });

  it("depth-1 through depth-3 chains run; the 4th hop dies (A→B→A cycles are bounded)", async () => {
    const { deps, runs, dispatcher } = await setup();
    await runRunCompletedPollSweep(deps, at(0)); // baseline
    let depth = 0;
    for (let hop = 1; hop <= MAX_TRIGGER_CHAIN_DEPTH + 1; hop++) {
      runs.seed(
        makeRun({
          id: `cycle-${hop}`,
          finishedAt: at(hop),
          input: {
            prompt: "p",
            ...(depth > 0 ? { event: { name: "run_completed", chainDepth: depth } } : {}),
          },
        }),
      );
      await runRunCompletedPollSweep(deps, at(hop + 0.5));
      const latest = dispatcher.calls[dispatcher.calls.length - 1];
      depth = latest ? (latest.input.event as { chainDepth: number }).chainDepth : depth + 1;
    }
    // Hops 1..MAX dispatched; the hop that would carry MAX+1 was refused.
    expect(dispatcher.calls).toHaveLength(MAX_TRIGGER_CHAIN_DEPTH);
  });
});
