/**
 * Wave 4 pre-run approval tests: the requireApproval hold in the gate chain
 * (awaiting_approval log, prompt callback carries the ONE-TIME token, hash-only
 * storage, fail-closed without a pending store), and the resolution round-trip
 * (approve → the held event re-runs the FULL chain and creates a run; deny /
 * expiry / double-click / foreign-user / bad-token → no run, S4 pre-run only).
 */

import { describe, expect, it } from "vitest";
import {
  consumeTriggerEvent,
  type ConsumeTriggerEventDeps,
  type CreateAndDispatchTriggerRun,
  type TriggerRunRequest,
} from "../src/core/trigger-runner.js";
import { resolvePendingApprovalToken } from "../src/core/pending-approval.js";
import { hashWebhookSecret } from "../src/core/webhook-secret.js";
import type { AutoRun, KitRef, PendingTriggerApproval, Trigger } from "../src/core/types.js";
import { InMemoryApprovalRepo } from "./approval-repo-fake.js";
import {
  fakeCanStart,
  InMemoryFireLogRepo,
  InMemoryPendingApprovalRepo,
  InMemoryTriggerRepo,
} from "./fakes.js";

const KIT: KitRef = { source: "local", localKitId: "k1" };
const NOW = "2026-07-03T12:00:00.000Z";
const SOON = "2026-07-03T12:10:00.000Z";
const PAST_TTL = "2026-07-03T13:30:00.000Z";

function makeTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: "trig-a",
    userId: "u1",
    name: "guarded",
    type: "message",
    config: { platform: "slack", sourceId: "src-1", connectionId: "conn-bot", scope: "channel", channelId: null },
    kitRef: KIT,
    approvalId: "appr-1",
    budgetCents: 100,
    mapping: { promptTemplate: "Do {{text}}", attachPayloadAs: "event.json", fileHandling: "attach" },
    rateLimit: { maxPerHour: 20 },
    requireApproval: true,
    enabled: true,
    cursor: null,
    circuit: { consecutiveFailures: 0, pausedAt: null },
    createdAt: NOW,
    updatedAt: NOW,
    fireCount: 0,
    ...over,
  } as Trigger;
}

async function setup(over: { trigger?: Partial<Trigger>; withPendingStore?: boolean } = {}) {
  const triggers = new InMemoryTriggerRepo();
  const approvals = new InMemoryApprovalRepo();
  const fireLogs = new InMemoryFireLogRepo();
  const pendingApprovals = new InMemoryPendingApprovalRepo();
  const dispatched: TriggerRunRequest[] = [];
  let seq = 0;
  const createAndDispatch: CreateAndDispatchTriggerRun = async (req) => {
    dispatched.push(req);
    return {
      id: `run-${++seq}`,
      userId: req.trigger.userId,
      kitRef: req.trigger.kitRef,
      status: "queued",
      input: req.input,
      budgetCents: 100,
      spentCents: 0,
      model: "m",
      createdAt: req.firedAt,
      auditLog: [],
    } as AutoRun;
  };
  await approvals.createApproval({
    userId: "u1",
    kitRef: KIT,
    toolAllowlist: [],
    maxBudgetCents: 1000,
    createdAt: NOW,
  });
  const trigger = triggers.seed(makeTrigger(over.trigger));
  const prompts: { pending: PendingTriggerApproval; token: string }[] = [];
  const deps: ConsumeTriggerEventDeps = {
    triggers,
    approvals,
    fireLogs,
    canStartRun: fakeCanStart(true).fn,
    createAndDispatch,
    ...(over.withPendingStore === false ? {} : { pendingApprovals }),
    onApprovalRequested: async (pending, token) => {
      prompts.push({ pending, token });
    },
  };
  return { triggers, approvals, fireLogs, pendingApprovals, dispatched, trigger, deps, prompts };
}

const EVENT = {
  name: "message",
  payload: { channel: "C1", threadTs: "1.2", user: "U1", text: "deploy", ts: "1.2" },
  receivedAt: NOW,
};

describe("requireApproval hold (gate chain)", () => {
  it("holds a passing fire: awaiting_approval log, pending row with HASHED token, no run", async () => {
    const s = await setup();
    const log = await consumeTriggerEvent(s.trigger, EVENT, s.deps);
    expect(log.outcome).toBe("awaiting_approval");
    expect(s.dispatched.length).toBe(0);
    expect(s.prompts.length).toBe(1);
    const { pending, token } = s.prompts[0]!;
    // S2: only the sha256 hash is stored; the plaintext rides in the prompt.
    expect(pending.tokenHash).toBe(hashWebhookSecret(token));
    expect(pending.tokenHash).not.toBe(token);
    expect(pending.status).toBe("pending");
    expect(pending.event.payload).toEqual(EVENT.payload);
    // TTL stamped one hour out.
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)).toBe(3_600_000);
  });

  it("earlier gates still run BEFORE the hold (a filtered event is never held)", async () => {
    const s = await setup({
      trigger: { filters: [{ path: "text", op: "eq", value: "other" }] } as Partial<Trigger>,
    });
    const log = await consumeTriggerEvent(s.trigger, EVENT, s.deps);
    expect(log.outcome).toBe("filtered");
    expect(s.prompts.length).toBe(0);
  });

  it("FAILS CLOSED without a pending store: error log, no run, circuit failure", async () => {
    const s = await setup({ withPendingStore: false });
    const log = await consumeTriggerEvent(s.trigger, EVENT, s.deps);
    expect(log.outcome).toBe("error");
    expect(log.detail).toContain("requireApproval");
    expect(s.dispatched.length).toBe(0);
    expect((await s.triggers.getTrigger("trig-a"))!.circuit.consecutiveFailures).toBe(1);
  });

  it("a failed prompt send leaves the hold in place (detail notes it; still approvable)", async () => {
    const s = await setup();
    s.deps.onApprovalRequested = async () => {
      throw new Error("slack down");
    };
    const log = await consumeTriggerEvent(s.trigger, EVENT, s.deps);
    expect(log.outcome).toBe("awaiting_approval");
    expect(log.detail).toContain("prompt not delivered");
    expect([...s.pendingApprovals.pendings.values()][0]!.status).toBe("pending");
  });
});

describe("resolvePendingApprovalToken", () => {
  async function hold(s: Awaited<ReturnType<typeof setup>>) {
    await consumeTriggerEvent(s.trigger, EVENT, s.deps);
    return s.prompts[0]!;
  }

  it("approve → the HELD event re-runs the FULL chain and creates a run (S4 pre-run)", async () => {
    const s = await setup();
    const { token } = await hold(s);
    const result = await resolvePendingApprovalToken(token, "approve", "u1", s.deps, SOON);
    expect(result.outcome).toBe("approved");
    expect(result.runId).toBe("run-1");
    expect(s.dispatched.length).toBe(1);
    // The re-presented fire went through the mapping evaluator (S1) and
    // reconstructed the slack origin for reply destinations.
    expect(s.dispatched[0]!.input.prompt).toBe("Do deploy");
    expect(s.dispatched[0]!.input.event).toMatchObject({
      origin: { platform: "slack", channel: "C1", threadTs: "1.2" },
    });
    expect([...s.pendingApprovals.pendings.values()][0]!.status).toBe("approved");
  });

  it("approve re-runs the gates against CURRENT state (a disabled trigger stays suppressed)", async () => {
    const s = await setup();
    const { token } = await hold(s);
    await s.triggers.updateTrigger("trig-a", { enabled: false, updatedAt: SOON });
    const result = await resolvePendingApprovalToken(token, "approve", "u1", s.deps, SOON);
    expect(result.outcome).toBe("approved"); // the click consumed the hold…
    expect(result.fireLog!.outcome).toBe("suppressed_circuit"); // …but the chain said no
    expect(s.dispatched.length).toBe(0);
  });

  it("deny → approval_denied log, no run; a second click finds nothing (single consume)", async () => {
    const s = await setup();
    const { token } = await hold(s);
    const denied = await resolvePendingApprovalToken(token, "deny", "u1", s.deps, SOON);
    expect(denied.outcome).toBe("denied");
    expect(denied.fireLog!.outcome).toBe("approval_denied");
    expect(s.dispatched.length).toBe(0);

    const again = await resolvePendingApprovalToken(token, "approve", "u1", s.deps, SOON);
    expect(again.outcome).toBe("not_found");
    expect(s.dispatched.length).toBe(0);
  });

  it("double APPROVE can never fire twice", async () => {
    const s = await setup();
    const { token } = await hold(s);
    const first = await resolvePendingApprovalToken(token, "approve", "u1", s.deps, SOON);
    expect(first.outcome).toBe("approved");
    const second = await resolvePendingApprovalToken(token, "approve", "u1", s.deps, SOON);
    expect(second.outcome).toBe("not_found");
    expect(s.dispatched.length).toBe(1);
  });

  it("expired holds cannot be approved (lazy TTL)", async () => {
    const s = await setup();
    const { token } = await hold(s);
    const result = await resolvePendingApprovalToken(token, "approve", "u1", s.deps, PAST_TTL);
    expect(result.outcome).toBe("expired");
    expect(result.fireLog!.outcome).toBe("approval_denied");
    expect(s.dispatched.length).toBe(0);
    expect([...s.pendingApprovals.pendings.values()][0]!.status).toBe("expired");
  });

  it("foreign-user callbacks and unknown tokens resolve to a uniform not_found", async () => {
    const s = await setup();
    const { token } = await hold(s);
    expect(
      (await resolvePendingApprovalToken(token, "approve", "attacker", s.deps, SOON)).outcome,
    ).toBe("not_found");
    expect(
      (await resolvePendingApprovalToken("wrong-token", "approve", "u1", s.deps, SOON)).outcome,
    ).toBe("not_found");
    // The real owner can still approve after the failed attempts.
    expect((await resolvePendingApprovalToken(token, "approve", "u1", s.deps, SOON)).outcome).toBe(
      "approved",
    );
  });
});
