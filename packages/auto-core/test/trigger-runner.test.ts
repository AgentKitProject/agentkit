/**
 * Trigger-runner tests: every gate-chain exit in order (disabled,
 * circuit-paused, filtered, rate-capped incl. boundary, skipped_funds +
 * circuit pause at the threshold, ledger_unavailable managed-vs-byo split,
 * approval denied, happy run_created + counter reset), never-throws isolation,
 * and schedule-type due-run parity with the schedule-runner semantics
 * (persist-before-dispatch, no double fire, cursor always advances).
 */

import { describe, expect, it } from "vitest";
import {
  CIRCUIT_PAUSE_AFTER_CONSECUTIVE,
  consumeTriggerEvent,
  runDueScheduleTriggers,
  type ConsumeTriggerEventDeps,
  type CreateAndDispatchTriggerRun,
  type TriggerRunRequest,
} from "../src/core/trigger-runner.js";
import type { AutoRun, KitRef, Trigger, TriggerFireLog } from "../src/core/types.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import { fakeCanStart, InMemoryFireLogRepo, InMemoryTriggerRepo } from "./fakes.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const NOW = "2026-06-18T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function makeTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: "trig-x",
    userId: "u1",
    name: "on push",
    type: "event",
    config: { sourceId: "src-1", eventName: null },
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 200,
    mapping: { promptTemplate: "Handle {{action}}.", attachPayloadAs: "event.json", fileHandling: "attach" },
    rateLimit: { maxPerHour: 20 },
    enabled: true,
    cursor: null,
    circuit: { consecutiveFailures: 0, pausedAt: null },
    createdAt: NOW,
    updatedAt: NOW,
    fireCount: 0,
    ...over,
  } as Trigger;
}

function fakeDispatcher(fail = false): { fn: CreateAndDispatchTriggerRun; calls: TriggerRunRequest[] } {
  const calls: TriggerRunRequest[] = [];
  let seq = 0;
  const fn: CreateAndDispatchTriggerRun = async (req) => {
    calls.push(req);
    if (fail) throw new Error("dispatch exploded");
    const run: AutoRun = {
      id: `run-${++seq}`,
      userId: req.trigger.userId,
      kitRef: req.trigger.kitRef,
      status: "queued",
      input: req.input,
      budgetCents: req.trigger.budgetCents ?? 0,
      spentCents: 0,
      model: req.trigger.model ?? "claude-sonnet-4-6",
      createdAt: req.firedAt,
      auditLog: [],
    };
    return run;
  };
  return { fn, calls };
}

async function setup(over: {
  trigger?: Partial<Trigger>;
  canStart?: ReturnType<typeof fakeCanStart>;
  dispatchFail?: boolean;
  approval?: false | { maxBudgetCents: number };
} = {}) {
  const triggers = new InMemoryTriggerRepo();
  const approvals = new InMemoryApprovalRepo();
  const fireLogs = new InMemoryFireLogRepo();
  const canStart = over.canStart ?? fakeCanStart(true);
  const dispatcher = fakeDispatcher(over.dispatchFail ?? false);
  if (over.approval !== false) {
    await approvals.createApproval({
      userId: "u1",
      kitRef: KIT,
      toolAllowlist: ["read_file"],
      maxBudgetCents: over.approval?.maxBudgetCents ?? 1000,
      createdAt: NOW,
    });
  }
  const trigger = triggers.seed(makeTrigger(over.trigger));
  const deps: ConsumeTriggerEventDeps = {
    triggers,
    approvals,
    fireLogs,
    canStartRun: canStart.fn,
    createAndDispatch: dispatcher.fn,
  };
  return { triggers, approvals, fireLogs, canStart, dispatcher, trigger, deps };
}

const EVENT = { name: "repo.push", payload: { action: "push" }, receivedAt: NOW };

async function lastLog(fireLogs: InMemoryFireLogRepo, triggerId: string): Promise<TriggerFireLog | undefined> {
  return (await fireLogs.listFireLogsByTrigger(triggerId, 1))[0];
}

describe("consumeTriggerEvent — gate chain", () => {
  it("(a) disabled → suppressed_circuit, nothing else runs", async () => {
    const { deps, dispatcher, canStart, fireLogs, trigger } = await setup({
      trigger: { enabled: false },
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("suppressed_circuit");
    expect(log.detail).toContain("disabled");
    expect(dispatcher.calls).toHaveLength(0);
    expect(canStart.calls).toHaveLength(0);
    expect(await lastLog(fireLogs, trigger.id)).toMatchObject({ outcome: "suppressed_circuit" });
  });

  it("(a) circuit paused → suppressed_circuit", async () => {
    const { deps, dispatcher, trigger } = await setup({
      trigger: { circuit: { consecutiveFailures: 10, pausedAt: isoAgo(60_000) } },
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("suppressed_circuit");
    expect(log.detail).toContain("paused");
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("(b) failing filters → filtered, NO circuit penalty", async () => {
    const { deps, triggers, dispatcher, canStart, trigger } = await setup({
      trigger: { filters: [{ path: "action", op: "eq", value: "delete" }] },
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("filtered");
    expect(log.detail).toContain("action eq");
    expect(dispatcher.calls).toHaveLength(0);
    expect(canStart.calls).toHaveLength(0); // filters exit before the rate/funds gates
    const after = await triggers.getTrigger(trigger.id);
    expect(after?.circuit.consecutiveFailures).toBe(0);
  });

  it("(b) passing filters continue down the chain", async () => {
    const { deps, dispatcher, trigger } = await setup({
      trigger: { filters: [{ path: "action", op: "eq", value: "push" }] },
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("run_created");
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("(c) rate cap: maxPerHour run_created fires in the window suppress", async () => {
    const { deps, fireLogs, canStart, dispatcher, trigger } = await setup({
      trigger: { rateLimit: { maxPerHour: 2 } },
    });
    for (const at of [isoAgo(10 * 60_000), isoAgo(30 * 60_000)]) {
      await fireLogs.appendFireLog({ triggerId: trigger.id, at, outcome: "run_created", runId: "r" });
    }
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("suppressed_rate");
    expect(canStart.calls).toHaveLength(0); // rate exits before the funds gate
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("(c) rate boundary: maxPerHour-1 fires still fire; old + non-run logs don't count", async () => {
    const { deps, fireLogs, trigger } = await setup({ trigger: { rateLimit: { maxPerHour: 2 } } });
    // One in-window run_created + one OUTSIDE the window + non-run outcomes.
    await fireLogs.appendFireLog({ triggerId: trigger.id, at: isoAgo(10 * 60_000), outcome: "run_created", runId: "r" });
    await fireLogs.appendFireLog({ triggerId: trigger.id, at: isoAgo(61 * 60_000), outcome: "run_created", runId: "r" });
    await fireLogs.appendFireLog({ triggerId: trigger.id, at: isoAgo(5 * 60_000), outcome: "filtered" });
    await fireLogs.appendFireLog({ triggerId: trigger.id, at: isoAgo(5 * 60_000), outcome: "suppressed_rate" });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("run_created");
  });

  it("(d) insufficient_funds → skipped_funds + circuit failure; pauses at the threshold", async () => {
    const { deps, triggers, canStart, dispatcher, trigger } = await setup({
      canStart: fakeCanStart(false, "insufficient_funds"),
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("skipped_funds");
    expect(canStart.calls).toEqual([{ userId: "u1", mode: "managed" }]);
    expect(dispatcher.calls).toHaveLength(0);
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(1);

    // Reaching CIRCUIT_PAUSE_AFTER_CONSECUTIVE pauses the trigger.
    for (let i = 1; i < CIRCUIT_PAUSE_AFTER_CONSECUTIVE; i++) {
      const fresh = await triggers.getTrigger(trigger.id);
      await consumeTriggerEvent(fresh!, EVENT, deps);
    }
    const after = await triggers.getTrigger(trigger.id);
    expect(after?.circuit.consecutiveFailures).toBe(CIRCUIT_PAUSE_AFTER_CONSECUTIVE);
    expect(after?.circuit.pausedAt).toBe(NOW);
    // And once paused, the next fire is suppressed at gate (a).
    const next = await consumeTriggerEvent(after!, EVENT, deps);
    expect(next.outcome).toBe("suppressed_circuit");
  });

  it("(d) ledger_unavailable: managed FAILS CLOSED (skipped_funds, no circuit penalty)", async () => {
    const { deps, triggers, dispatcher, trigger } = await setup({
      canStart: fakeCanStart(false, "ledger_unavailable"),
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("skipped_funds");
    expect(log.detail?.toLowerCase()).toContain("ledger");
    expect(dispatcher.calls).toHaveLength(0);
    // An infra outage is not the trigger's fault — no circuit penalty.
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(0);
  });

  it("(d) ledger_unavailable: byo PROCEEDS", async () => {
    const { deps, dispatcher, canStart, trigger } = await setup({
      canStart: fakeCanStart(false, "ledger_unavailable"),
    });
    const log = await consumeTriggerEvent(trigger, EVENT, { ...deps, inferenceMode: "byo" });
    expect(canStart.calls).toEqual([{ userId: "u1", mode: "byo" }]);
    expect(log.outcome).toBe("run_created");
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("(d) funds exits before the approval gate", async () => {
    const { deps, trigger } = await setup({
      canStart: fakeCanStart(false, "insufficient_funds"),
      approval: false, // approval ALSO missing — funds must win the ordering
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("skipped_funds");
  });

  it("(e) missing approval → error + circuit failure", async () => {
    const { deps, triggers, dispatcher, trigger } = await setup({ approval: false });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("error");
    expect(log.detail).toContain("No standing approval");
    expect(dispatcher.calls).toHaveLength(0);
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(1);
  });

  it("(e) revoked approval → error", async () => {
    const { deps, approvals, trigger } = await setup();
    const [approval] = await approvals.listApprovalsByUser("u1");
    await approvals.revokeApproval(approval!.id, NOW);
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("error");
  });

  it("(e) budget over the approval ceiling → error; 0 ceiling = unlimited", async () => {
    const over = await setup({ approval: { maxBudgetCents: 100 }, trigger: { budgetCents: 500 } });
    const log = await consumeTriggerEvent(over.trigger, EVENT, over.deps);
    expect(log.outcome).toBe("error");
    expect(log.detail).toContain("exceeds the approval ceiling");

    const unlimited = await setup({ approval: { maxBudgetCents: 0 }, trigger: { budgetCents: 999999 } });
    const ok = await consumeTriggerEvent(unlimited.trigger, EVENT, unlimited.deps);
    expect(ok.outcome).toBe("run_created");
  });

  it("(f) happy path: run_created, S1-safe input, recordFire, circuit reset", async () => {
    const { deps, triggers, dispatcher, fireLogs, trigger } = await setup({
      trigger: { circuit: { consecutiveFailures: 5, pausedAt: null } },
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("run_created");
    expect(log.runId).toBe("run-1");

    // The dispatched input came from the mapping evaluator (S1).
    expect(dispatcher.calls).toHaveLength(1);
    const req = dispatcher.calls[0]!;
    expect(req.trigger.id).toBe(trigger.id);
    expect(req.firedAt).toBe(NOW);
    expect(req.input.prompt).toBe("Handle push.");
    expect(req.input.event).toEqual({ name: "repo.push" });
    expect(req.input.files).toEqual([{ path: "event.json", content: '{"action":"push"}' }]);

    const after = await triggers.getTrigger(trigger.id);
    expect(after?.fireCount).toBe(1);
    expect(after?.lastFiredAt).toBe(NOW);
    expect(after?.lastRunId).toBe("run-1");
    expect(after?.circuit.consecutiveFailures).toBe(0); // reset on success
    expect(await lastLog(fireLogs, trigger.id)).toMatchObject({ outcome: "run_created", runId: "run-1" });
  });

  it("dispatch failure → error outcome + circuit failure, NEVER throws", async () => {
    const { deps, triggers, trigger } = await setup({ dispatchFail: true });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("error");
    expect(log.detail).toContain("dispatch exploded");
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(1);
    expect((await triggers.getTrigger(trigger.id))?.fireCount).toBe(0);
  });

  it("survives even a failing fire-log repository (returns an unpersisted row)", async () => {
    const { deps, trigger } = await setup();
    const broken = {
      ...deps,
      fireLogs: {
        appendFireLog: async () => {
          throw new Error("db down");
        },
        listFireLogsByTrigger: async () => {
          throw new Error("db down");
        },
      },
    };
    const log = await consumeTriggerEvent(trigger, EVENT, broken);
    expect(log.outcome).toBe("error");
    expect(log.id).toBe("unpersisted");
  });

  it("gate ORDER: disabled beats failing filters (a before b)", async () => {
    const { deps, trigger } = await setup({
      trigger: { enabled: false, filters: [{ path: "action", op: "eq", value: "nope" }] },
    });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("suppressed_circuit");
  });

  it("gate ORDER: filtered beats rate cap (b before c)", async () => {
    const { deps, fireLogs, trigger } = await setup({
      trigger: {
        rateLimit: { maxPerHour: 1 },
        filters: [{ path: "action", op: "eq", value: "nope" }],
      },
    });
    await fireLogs.appendFireLog({ triggerId: trigger.id, at: isoAgo(60_000), outcome: "run_created", runId: "r" });
    const log = await consumeTriggerEvent(trigger, EVENT, deps);
    expect(log.outcome).toBe("filtered");
  });
});

describe("runDueScheduleTriggers", () => {
  function scheduleTrigger(over: Partial<Trigger> = {}): Trigger {
    return makeTrigger({
      id: "trig-sched",
      type: "schedule",
      config: { cron: "*/5 * * * *", timezone: "UTC" },
      mapping: { promptTemplate: "Do the daily digest.", attachPayloadAs: "event.json", fileHandling: "attach" },
      cursor: isoAgo(5 * 60_000), // due
      ...over,
    } as Partial<Trigger>);
  }

  async function scheduleSetup(over: Parameters<typeof setup>[0] = {}) {
    return setup({
      ...over,
      trigger: { ...scheduleTrigger(), ...(over.trigger ?? {}) } as Partial<Trigger>,
    });
  }

  it("fires a due schedule trigger: verbatim prompt, no payload, no files", async () => {
    const { deps, triggers, dispatcher, trigger } = await scheduleSetup();
    const summary = await runDueScheduleTriggers(deps, NOW);
    expect(summary).toEqual({ processed: 1, dispatched: 1, skipped: 0, errors: [] });
    const req = dispatcher.calls[0]!;
    expect(req.input.prompt).toBe("Do the daily digest.");
    expect(req.input.files).toBeUndefined();
    expect(req.input.event).toEqual({ name: "schedule" });
    // Cursor advanced to the next cron fire after NOW (12:00 → 12:05).
    expect((await triggers.getTrigger(trigger.id))?.cursor).toBe("2026-06-18T12:05:00.000Z");
  });

  it("persists the cursor BEFORE dispatch (double-fire guard)", async () => {
    const triggers = new InMemoryTriggerRepo();
    const approvals = new InMemoryApprovalRepo();
    const fireLogs = new InMemoryFireLogRepo();
    await approvals.createApproval({
      userId: "u1", kitRef: KIT, toolAllowlist: [], maxBudgetCents: 0, createdAt: NOW,
    });
    const trigger = triggers.seed(scheduleTrigger());
    const cursorsAtDispatch: Array<string | null | undefined> = [];
    const deps: ConsumeTriggerEventDeps = {
      triggers,
      approvals,
      fireLogs,
      canStartRun: fakeCanStart(true).fn,
      createAndDispatch: async (req) => {
        cursorsAtDispatch.push((await triggers.getTrigger(trigger.id))?.cursor);
        return {
          id: "run-1", userId: req.trigger.userId, kitRef: req.trigger.kitRef, status: "queued",
          input: req.input, budgetCents: 0, spentCents: 0, model: "m", createdAt: req.firedAt, auditLog: [],
        };
      },
    };
    await runDueScheduleTriggers(deps, NOW);
    // At dispatch time the cursor was ALREADY advanced past NOW.
    expect(cursorsAtDispatch).toEqual(["2026-06-18T12:05:00.000Z"]);
  });

  it("does not double-fire on a re-entrant sweep at the same instant", async () => {
    const { deps, dispatcher } = await scheduleSetup();
    const first = await runDueScheduleTriggers(deps, NOW);
    const second = await runDueScheduleTriggers(deps, NOW);
    expect(first.dispatched).toBe(1);
    expect(second).toEqual({ processed: 0, dispatched: 0, skipped: 0, errors: [] });
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("skips filters entirely for schedule triggers (degenerate case)", async () => {
    const { deps } = await scheduleSetup({
      // An exists filter would FAIL against the absent payload if evaluated.
      trigger: { filters: [{ path: "anything", op: "exists" }] },
    });
    const summary = await runDueScheduleTriggers(deps, NOW);
    expect(summary.dispatched).toBe(1);
  });

  it("advances the cursor even when the fire is skipped (no hot-loop)", async () => {
    const { deps, triggers, trigger } = await scheduleSetup({
      canStart: fakeCanStart(false, "insufficient_funds"),
    });
    const summary = await runDueScheduleTriggers(deps, NOW);
    expect(summary).toMatchObject({ processed: 1, dispatched: 0, skipped: 1 });
    expect((await triggers.getTrigger(trigger.id))?.cursor).toBe("2026-06-18T12:05:00.000Z");
    // And the trigger has left the due set.
    expect(await triggers.listDue("schedule", NOW)).toHaveLength(0);
  });

  it("advances the cursor on error outcomes and isolates them in the summary", async () => {
    const { deps, triggers, trigger } = await scheduleSetup({ dispatchFail: true });
    const summary = await runDueScheduleTriggers(deps, NOW);
    expect(summary.errors).toEqual([{ triggerId: trigger.id, error: "dispatch exploded" }]);
    expect((await triggers.getTrigger(trigger.id))?.cursor).toBe("2026-06-18T12:05:00.000Z");
  });

  it("nudges an unparseable cron one minute past now (no hot-loop)", async () => {
    const { deps, triggers, trigger } = await scheduleSetup({
      trigger: { config: { cron: "not a cron" } } as Partial<Trigger>,
    });
    await runDueScheduleTriggers(deps, NOW);
    expect((await triggers.getTrigger(trigger.id))?.cursor).toBe(
      new Date(NOW_MS + 60_000).toISOString(),
    );
  });

  it("does not select disabled or circuit-paused schedule triggers", async () => {
    const disabled = await scheduleSetup({ trigger: { enabled: false } });
    expect(await runDueScheduleTriggers(disabled.deps, NOW)).toMatchObject({ processed: 0 });
    const paused = await scheduleSetup({
      trigger: { circuit: { consecutiveFailures: 10, pausedAt: NOW } },
    });
    expect(await runDueScheduleTriggers(paused.deps, NOW)).toMatchObject({ processed: 0 });
  });

  it("does not select schedule triggers whose cursor is in the future", async () => {
    const { deps, dispatcher } = await scheduleSetup({
      trigger: { cursor: "2026-06-18T12:05:00.000Z" },
    });
    const summary = await runDueScheduleTriggers(deps, NOW);
    expect(summary.processed).toBe(0);
    expect(dispatcher.calls).toHaveLength(0);
  });
});
