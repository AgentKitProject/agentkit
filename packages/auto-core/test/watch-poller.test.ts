/**
 * Watch-poller tests (Wave 3b): baseline-first-sweep (no event storm),
 * includeExisting, created/updated/deleted diffing, per-sweep cap with
 * next-sweep pickup, persist-cursor-before-dispatch (no-dupe beats no-miss,
 * incl. across a "restart"), interval gating, pattern filtering, per_batch
 * mode, poll-failure → error fire log + circuit counting, and per-trigger
 * sweep isolation.
 */

import { describe, expect, it } from "vitest";
import {
  runWatchPollSweep,
  WATCH_MAX_EVENTS_PER_SWEEP,
  type S3ListObjectsFn,
  type S3ObjectSummary,
  type WatchCursor,
  type WatchPollDeps,
} from "../src/core/watch-poller.js";
import type {
  CreateAndDispatchTriggerRun,
  TriggerRunRequest,
} from "../src/core/trigger-runner.js";
import type { AutoRun, Connection, KitRef, Trigger } from "../src/core/types.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import {
  fakeCanStart,
  InMemoryConnectionRepo,
  InMemoryFireLogRepo,
  InMemorySecretStore,
  InMemoryTriggerRepo,
} from "./fakes.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const T0 = "2026-07-03T12:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function obj(key: string, etag: string, minutesAgo = 60): S3ObjectSummary {
  return { key, size: 10, etag, lastModified: at(-minutesAgo) };
}

function makeWatchTrigger(over: Partial<Trigger> = {}, config: Record<string, unknown> = {}): Trigger {
  return {
    id: "watch-1",
    userId: "u1",
    name: "inbox watch",
    type: "watch",
    config: {
      connectionId: "conn-s3",
      prefix: "",
      pattern: null,
      batchMode: "per_file",
      intervalMinutes: 1,
      includeExisting: false,
      ...config,
    },
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 200,
    mapping: { promptTemplate: "New file {{key}} ({{eventName}}).", attachPayloadAs: "event.json", fileHandling: "attach" },
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

function fakeDispatcher(fail = false): { fn: CreateAndDispatchTriggerRun; calls: TriggerRunRequest[] } {
  const calls: TriggerRunRequest[] = [];
  let seq = 0;
  const fn: CreateAndDispatchTriggerRun = async (req) => {
    calls.push(req);
    if (fail) throw new Error("dispatch exploded");
    return {
      id: `run-${++seq}`,
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

async function setup(over: {
  trigger?: Partial<Trigger>;
  config?: Record<string, unknown>;
  listing?: S3ObjectSummary[];
  listError?: string;
  dispatchFail?: boolean;
  connection?: Partial<Connection> | false;
} = {}) {
  const triggers = new InMemoryTriggerRepo();
  const approvals = new InMemoryApprovalRepo();
  const fireLogs = new InMemoryFireLogRepo();
  const connections = new InMemoryConnectionRepo();
  const secrets = new InMemorySecretStore();
  const dispatcher = fakeDispatcher(over.dispatchFail ?? false);

  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: ["read_file"],
    maxBudgetCents: 1000,
    createdAt: T0,
  });

  const secretRef = await secrets.put(JSON.stringify({ accessKeyId: "AK", secretAccessKey: "SK" }));
  if (over.connection !== false) {
    connections.seed({
      id: "conn-s3",
      ownerType: "user",
      ownerId: "u1",
      name: "bucket",
      type: "s3",
      config: { bucket: "drop", region: "us-east-1" },
      secretRef,
      status: "ok",
      createdAt: T0,
      ...(over.connection ?? {}),
    } as Connection);
  }

  const trigger = triggers.seed(makeWatchTrigger(over.trigger, over.config));

  // Mutable listing so tests evolve the bucket between sweeps.
  const state = { listing: over.listing ?? [], listCalls: 0 };
  const s3List: S3ListObjectsFn = async (args) => {
    state.listCalls += 1;
    expect(args.credentials).toEqual({ accessKeyId: "AK", secretAccessKey: "SK" });
    // listError only afflicts the primary bucket, so isolation tests can pair
    // a broken trigger with a healthy one on another connection.
    if (over.listError && args.bucket === "drop") throw new Error(over.listError);
    return state.listing.filter((o) => o.key.startsWith(args.prefix));
  };

  const deps: WatchPollDeps = {
    triggers,
    approvals,
    fireLogs,
    canStartRun: fakeCanStart(true).fn,
    createAndDispatch: dispatcher.fn,
    connections,
    secrets,
    s3List,
  };
  return { triggers, approvals, fireLogs, connections, secrets, dispatcher, trigger, deps, state };
}

async function cursorOf(triggers: InMemoryTriggerRepo, id: string): Promise<WatchCursor> {
  const t = await triggers.getTrigger(id);
  return JSON.parse(t!.cursor as string) as WatchCursor;
}

describe("watch poller — baseline + diffing", () => {
  it("first sweep BASELINES a pre-populated bucket (no event storm), then fires only new objects", async () => {
    const { deps, triggers, dispatcher, trigger, state } = await setup({
      listing: [obj("a.txt", "e1"), obj("b.txt", "e2")],
    });

    const first = await runWatchPollSweep(deps, at(0));
    expect(first.processed).toBe(1);
    expect(first.dispatched).toBe(0);
    expect(dispatcher.calls).toHaveLength(0);
    expect((await cursorOf(triggers, trigger.id)).objects).toEqual({ "a.txt": "e1", "b.txt": "e2" });

    state.listing.push(obj("c.txt", "e3", 1));
    const second = await runWatchPollSweep(deps, at(2));
    expect(second.dispatched).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
    // S1: promptTemplate is the instruction source; metadata interpolates as values.
    expect(dispatcher.calls[0]!.input.prompt).toBe("New file c.txt (object_created).");
    // The raw payload rides as an attached file, metadata only.
    const attached = JSON.parse(dispatcher.calls[0]!.input.files![0]!.content) as Record<string, unknown>;
    expect(attached).toEqual({
      key: "c.txt",
      size: 10,
      etag: "e3",
      lastModified: at(-1),
      eventName: "object_created",
    });

    // Third sweep: nothing new → nothing fires (no-dupe).
    const third = await runWatchPollSweep(deps, at(4));
    expect(third.dispatched).toBe(0);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("includeExisting: true fires existing objects on the first sweep", async () => {
    const { deps, dispatcher } = await setup({
      config: { includeExisting: true },
      listing: [obj("a.txt", "e1"), obj("b.txt", "e2")],
    });
    const summary = await runWatchPollSweep(deps, at(0));
    expect(summary.dispatched).toBe(2);
    expect(dispatcher.calls.map((c) => c.input.prompt).sort()).toEqual([
      "New file a.txt (object_created).",
      "New file b.txt (object_created).",
    ]);
  });

  it("changed etag → object_updated; deleted object → NO event and the cursor drops the key", async () => {
    const { deps, triggers, dispatcher, trigger, state } = await setup({
      listing: [obj("a.txt", "e1"), obj("b.txt", "e2")],
    });
    await runWatchPollSweep(deps, at(0)); // baseline

    state.listing = [obj("a.txt", "e1-changed", 1)]; // a updated, b deleted
    const summary = await runWatchPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(1);
    expect(dispatcher.calls[0]!.input.prompt).toBe("New file a.txt (object_updated).");
    const cursor = await cursorOf(triggers, trigger.id);
    expect(cursor.objects).toEqual({ "a.txt": "e1-changed" }); // b.txt gone, silently
  });

  it("pattern filters on the basename (literal-safe)", async () => {
    const { deps, dispatcher, state } = await setup({
      config: { pattern: "\\.csv$" },
      listing: [],
    });
    await runWatchPollSweep(deps, at(0)); // baseline (empty)
    state.listing.push(obj("in/data.csv", "e1", 1), obj("in/readme.txt", "e2", 1));
    const summary = await runWatchPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(1);
    expect(dispatcher.calls[0]!.input.prompt).toContain("in/data.csv");
  });

  it("per_batch mode fires ONE event carrying the whole batch (metadata only)", async () => {
    const { deps, dispatcher, state } = await setup({
      config: { batchMode: "per_batch" },
      trigger: { mapping: { promptTemplate: "Process {{count}} files.", attachPayloadAs: "event.json", fileHandling: "attach" } },
      listing: [],
    });
    await runWatchPollSweep(deps, at(0)); // baseline
    state.listing.push(obj("a.txt", "e1", 2), obj("b.txt", "e2", 1), obj("c.txt", "e3", 1));
    const summary = await runWatchPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]!.input.prompt).toBe("Process 3 files.");
    const payload = JSON.parse(dispatcher.calls[0]!.input.files![0]!.content) as { objects: unknown[] };
    expect(payload.objects).toHaveLength(3);
  });
});

describe("watch poller — cap + no-dupe-no-miss", () => {
  it("caps a sweep at WATCH_MAX_EVENTS_PER_SWEEP and picks the remainder up next sweep (no miss, no dupe)", async () => {
    const { deps, dispatcher, state } = await setup({ listing: [] });
    await runWatchPollSweep(deps, at(0)); // baseline (empty)

    for (let i = 0; i < WATCH_MAX_EVENTS_PER_SWEEP + 10; i++) {
      state.listing.push(obj(`f-${String(i).padStart(3, "0")}.txt`, `e${i}`, 1));
    }
    const second = await runWatchPollSweep(deps, at(2));
    expect(second.dispatched).toBe(WATCH_MAX_EVENTS_PER_SWEEP);

    const third = await runWatchPollSweep(deps, at(4));
    expect(third.dispatched).toBe(10);

    // Every object fired exactly once.
    const keys = dispatcher.calls.map((c) => (JSON.parse(c.input.files![0]!.content) as { key: string }).key);
    expect(new Set(keys).size).toBe(WATCH_MAX_EVENTS_PER_SWEEP + 10);

    const fourth = await runWatchPollSweep(deps, at(6));
    expect(fourth.dispatched).toBe(0);
  });

  it("persists the cursor BEFORE dispatch: a crash mid-dispatch can never double-fire (restart-safe)", async () => {
    const first = await setup({ listing: [obj("a.txt", "e1")] });
    await runWatchPollSweep(first.deps, at(0)); // baseline
    first.state.listing.push(obj("b.txt", "e2", 1));

    // Dispatch explodes AFTER the cursor was advanced.
    const broken = await setup({ dispatchFail: true });
    const brokenDeps: WatchPollDeps = { ...broken.deps, triggers: first.triggers, approvals: first.approvals, connections: first.connections, secrets: first.secrets, s3List: first.deps.s3List, fireLogs: first.fireLogs };
    const summary = await runWatchPollSweep(brokenDeps, at(2));
    expect(summary.errors).toHaveLength(1);

    // "Restart": a fresh sweep with a HEALTHY dispatcher re-reads the persisted
    // cursor — b.txt was acknowledged before dispatch, so it does NOT re-fire.
    const healthy = await runWatchPollSweep(first.deps, at(4));
    expect(healthy.dispatched).toBe(0);
    expect(first.dispatcher.calls).toHaveLength(0);
  });

  it("survives a restart with no dupe and no miss (cursor is the only state)", async () => {
    const s1 = await setup({ listing: [obj("a.txt", "e1")] });
    await runWatchPollSweep(s1.deps, at(0)); // baseline
    s1.state.listing.push(obj("b.txt", "e2", 1));
    await runWatchPollSweep(s1.deps, at(2)); // fires b.txt
    expect(s1.dispatcher.calls).toHaveLength(1);

    // "Restart": brand-new deps/poller instances sharing only the repos.
    const dispatcher2 = fakeDispatcher();
    const deps2: WatchPollDeps = { ...s1.deps, createAndDispatch: dispatcher2.fn };
    s1.state.listing.push(obj("c.txt", "e3", 1));
    const after = await runWatchPollSweep(deps2, at(4));
    expect(after.dispatched).toBe(1); // c.txt only — b.txt not re-fired
    const payload = JSON.parse(dispatcher2.calls[0]!.input.files![0]!.content) as { key: string };
    expect(payload.key).toBe("c.txt");
  });
});

describe("watch poller — interval, failures, isolation", () => {
  it("skips triggers not yet due per intervalMinutes (cursor polledAt gating)", async () => {
    const { deps, state, dispatcher } = await setup({
      config: { intervalMinutes: 5 },
      listing: [],
    });
    await runWatchPollSweep(deps, at(0)); // baseline at T0
    state.listing.push(obj("a.txt", "e1", 1));

    const early = await runWatchPollSweep(deps, at(1)); // 1 min later — not due
    expect(early.processed).toBe(0);
    expect(dispatcher.calls).toHaveLength(0);

    const due = await runWatchPollSweep(deps, at(5)); // 5 min later — due
    expect(due.processed).toBe(1);
    expect(due.dispatched).toBe(1);
  });

  it("a failing bucket records an 'error' fire log + circuit failure and never kills the sweep", async () => {
    const { deps, triggers, fireLogs, connections, secrets, trigger } = await setup({
      listError: "AccessDenied",
    });
    // A second, healthy trigger on the same sweep against ANOTHER bucket.
    const okRef = await secrets.put(JSON.stringify({ accessKeyId: "AK", secretAccessKey: "SK" }));
    connections.seed({
      id: "conn-ok",
      ownerType: "user",
      ownerId: "u1",
      name: "ok-bucket",
      type: "s3",
      config: { bucket: "drop2" },
      secretRef: okRef,
      status: "ok",
      createdAt: T0,
    } as Connection);
    const healthy = triggers.seed(makeWatchTrigger({ id: "watch-2" }, { connectionId: "conn-ok" }));

    const summary = await runWatchPollSweep(deps, at(0));
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ triggerId: trigger.id });
    const log = (await fireLogs.listFireLogsByTrigger(trigger.id, 1))[0];
    expect(log).toMatchObject({ outcome: "error" });
    expect(log!.detail).toContain("AccessDenied");
    expect((await triggers.getTrigger(trigger.id))?.circuit.consecutiveFailures).toBe(1);

    // The healthy trigger still baselined (sweep isolation).
    expect((await triggers.getTrigger(healthy.id))?.cursor).not.toBeNull();
  });

  it("missing / wrong-type / foreign connection → error fire log (no dispatch)", async () => {
    const missing = await setup({ connection: false });
    const s1 = await runWatchPollSweep(missing.deps, at(0));
    expect(s1.errors[0]?.error).toContain("not found");

    const wrongType = await setup({ connection: { type: "webhook_out" } as Partial<Connection> });
    const s2 = await runWatchPollSweep(wrongType.deps, at(0));
    expect(s2.errors[0]?.error).toContain("s3");

    const foreign = await setup({ connection: { ownerId: "someone-else" } });
    const s3 = await runWatchPollSweep(foreign.deps, at(0));
    expect(s3.errors[0]?.error).toContain("not owned");
    expect(foreign.dispatcher.calls).toHaveLength(0);
  });

  it("two watch triggers on the same connection each receive the event (poller fan-out parity)", async () => {
    const { deps, triggers, dispatcher, state } = await setup({ listing: [] });
    triggers.seed(makeWatchTrigger({ id: "watch-2", name: "second watcher" }));
    await runWatchPollSweep(deps, at(0)); // baseline both
    state.listing.push(obj("a.txt", "e1", 1));
    const summary = await runWatchPollSweep(deps, at(2));
    expect(summary.dispatched).toBe(2);
    expect(new Set(dispatcher.calls.map((c) => c.trigger.id))).toEqual(new Set(["watch-1", "watch-2"]));
  });
});
