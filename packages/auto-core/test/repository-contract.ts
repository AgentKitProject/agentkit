/**
 * Backend-parametric repository contract for the Auto core. Run against BOTH the
 * Postgres self-host adapter (pg-mem) and the AWS DynamoDB adapter
 * (dynamodb-local, gated) to prove parity — mirrors gateway-core / market-core.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoWebhookRepository,
  EventStorageDeps,
} from "../src/core/ports.js";
import type {
  CreateEventSourceInput,
  CreateRunInput,
  CreateApprovalInput,
  CreateScheduleInput,
  CreateTriggerInput,
  CreateWebhookInput,
} from "../src/core/types.js";
import { hashWebhookSecret } from "../src/core/webhook-secret.js";

export interface ContractRepos {
  runs: AutoRunRepository;
  approvals: AutoApprovalRepository;
  schedules: AutoScheduleRepository;
  webhooks: AutoWebhookRepository;
  /** Event-driven expansion stores (both persistent adapters provide them). */
  events: EventStorageDeps;
  reset: () => Promise<void>;
}

const NOW = "2026-06-18T00:00:00.000Z";

function runInput(over: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    input: { prompt: "task", files: [{ path: "in.txt", content: "x" }] },
    budgetCents: 500,
    model: "claude-sonnet-4-6",
    createdAt: NOW,
    ...over,
  };
}

function approvalInput(over: Partial<CreateApprovalInput> = {}): CreateApprovalInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    toolAllowlist: ["read_file", "write_file"],
    maxBudgetCents: 1000,
    createdAt: NOW,
    ...over,
  };
}

function scheduleInput(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    cron: "*/5 * * * *",
    timezone: "UTC",
    input: { prompt: "do it", files: [{ path: "in.txt", content: "x" }] },
    budgetCents: 200,
    model: "claude-sonnet-4-6",
    approvalId: "appr-1",
    createdAt: NOW,
    nextRunAt: "2026-06-18T00:05:00.000Z",
    ...over,
  };
}

function webhookInput(over: Partial<CreateWebhookInput> = {}): CreateWebhookInput {
  return {
    userId: "u1",
    kitRef: { source: "local", localKitId: "k1" },
    approvalId: "appr-1",
    budgetCents: 200,
    model: "claude-sonnet-4-6",
    secretHash: hashWebhookSecret("the-secret"),
    createdAt: NOW,
    ...over,
  };
}

function triggerInput(over: Partial<CreateTriggerInput> = {}): CreateTriggerInput {
  return {
    userId: "u1",
    name: "deploy watcher",
    type: "event",
    config: { sourceId: "src-1", eventName: "deploy" },
    kitRef: { source: "local", localKitId: "k1" },
    approvalId: "appr-1",
    mapping: { promptTemplate: "Handle {{action}}", attachPayloadAs: "event.json", fileHandling: "attach" },
    createdAt: NOW,
    ...over,
  } as CreateTriggerInput;
}

function eventSourceInput(over: Partial<CreateEventSourceInput> = {}): CreateEventSourceInput {
  return {
    userId: "u1",
    name: "ci events",
    kind: "custom",
    tokenHash: hashWebhookSecret("the-token"),
    hasSigningSecret: false,
    createdAt: NOW,
    ...over,
  };
}

export function runRepositoryContract(label: string, makeRepos: () => Promise<ContractRepos>): void {
  describe(`Auto repository contract [${label}]`, () => {
    let repos: ContractRepos;
    beforeEach(async () => {
      repos = await makeRepos();
      await repos.reset();
    });

    it("creates and reads a run (round-trips kitRef + input JSON)", async () => {
      const created = await repos.runs.createRun(runInput());
      expect(created.status).toBe("queued");
      expect(created.spentCents).toBe(0);
      const fetched = await repos.runs.getRun(created.id);
      expect(fetched?.kitRef).toEqual({ source: "local", localKitId: "k1" });
      expect(fetched?.input.files?.[0]?.path).toBe("in.txt");
      expect(fetched?.budgetCents).toBe(500);
    });

    it("records spend additively", async () => {
      const run = await repos.runs.createRun(runInput());
      expect(await repos.runs.recordSpend(run.id, 10)).toBe(10);
      expect(await repos.runs.recordSpend(run.id, 5)).toBe(15);
      expect((await repos.runs.getRun(run.id))?.spentCents).toBe(15);
    });

    it("appends audit entries in order (append-only)", async () => {
      const run = await repos.runs.createRun(runInput());
      await repos.runs.appendAudit(run.id, { tool: "read_file", argsSummary: "path=a", outcome: "ok", ts: NOW });
      await repos.runs.appendAudit(run.id, { tool: "write_file", argsSummary: "path=b", outcome: "rejected", ts: NOW });
      const log = (await repos.runs.getRun(run.id))?.auditLog ?? [];
      expect(log.map((e) => e.tool)).toEqual(["read_file", "write_file"]);
      expect(log[1]?.outcome).toBe("rejected");
    });

    it("updates status + stamps fields and sets a result", async () => {
      const run = await repos.runs.createRun(runInput());
      await repos.runs.updateRunStatus(run.id, "running", { startedAt: NOW, workspaceId: "ws-x" });
      await repos.runs.setResult(run.id, { output: "done", files: [{ path: "out.txt", sizeBytes: 4 }] });
      await repos.runs.updateRunStatus(run.id, "succeeded", { finishedAt: NOW });
      const fetched = await repos.runs.getRun(run.id);
      expect(fetched?.status).toBe("succeeded");
      expect(fetched?.workspaceId).toBe("ws-x");
      expect(fetched?.result?.output).toBe("done");
      expect(fetched?.result?.files[0]?.sizeBytes).toBe(4);
    });

    it("supports the kill-switch", async () => {
      const run = await repos.runs.createRun(runInput());
      expect(await repos.runs.isCancelRequested(run.id)).toBe(false);
      await repos.runs.requestCancel(run.id);
      expect(await repos.runs.isCancelRequested(run.id)).toBe(true);
    });

    it("lists runs by user", async () => {
      await repos.runs.createRun(runInput());
      await repos.runs.createRun(runInput());
      await repos.runs.createRun(runInput({ userId: "other" }));
      expect((await repos.runs.listRunsByUser("u1")).length).toBe(2);
    });

    it("counts ACTIVE (queued/running) runs per user (L4 concurrency cap)", async () => {
      // Both persistent adapters implement the optional native count.
      expect(typeof repos.runs.countActiveRuns).toBe("function");

      const queued = await repos.runs.createRun(runInput());
      const running = await repos.runs.createRun(runInput());
      const done = await repos.runs.createRun(runInput());
      const failed = await repos.runs.createRun(runInput());
      await repos.runs.createRun(runInput({ userId: "other" })); // other user's queued run
      await repos.runs.updateRunStatus(running.id, "running", { startedAt: NOW });
      await repos.runs.updateRunStatus(done.id, "succeeded", { finishedAt: NOW });
      await repos.runs.updateRunStatus(failed.id, "failed", { finishedAt: NOW, error: "x" });

      expect(await repos.runs.countActiveRuns!("u1")).toBe(2); // queued + running
      expect(await repos.runs.countActiveRuns!("other")).toBe(1);
      expect(await repos.runs.countActiveRuns!("nobody")).toBe(0);

      // Finishing the queued run drops the count.
      await repos.runs.updateRunStatus(queued.id, "canceled", { finishedAt: NOW });
      expect(await repos.runs.countActiveRuns!("u1")).toBe(1);
    });

    it("creates an approval and finds it by kit (non-revoked only)", async () => {
      const created = await repos.approvals.createApproval(approvalInput());
      expect(created.networkPolicy).toEqual({ mode: "deny_all" });
      expect(created.scope).toBe("workspace_read_write");
      const found = await repos.approvals.getApprovalForKit("u1", { source: "local", localKitId: "k1" });
      expect(found?.id).toBe(created.id);
      // Different kit → no match.
      expect(await repos.approvals.getApprovalForKit("u1", { source: "local", localKitId: "other" })).toBeUndefined();
    });

    it("revokes an approval so it no longer matches", async () => {
      const created = await repos.approvals.createApproval(approvalInput());
      await repos.approvals.revokeApproval(created.id, NOW);
      expect(
        await repos.approvals.getApprovalForKit("u1", { source: "local", localKitId: "k1" }),
      ).toBeUndefined();
      // Still listed (for history), but revoked.
      const listed = await repos.approvals.listApprovalsByUser("u1");
      expect(listed.find((a) => a.id === created.id)?.revokedAt).toBe(NOW);
    });

    // ---- Runs: Phase B trigger/scheduleId back-compat -------------------
    it("defaults trigger to on_demand and round-trips schedule runs", async () => {
      const onDemand = await repos.runs.createRun(runInput());
      expect((await repos.runs.getRun(onDemand.id))?.trigger).toBe("on_demand");

      const scheduled = await repos.runs.createRun(
        runInput({ trigger: "schedule", scheduleId: "sched-1" }),
      );
      const fetched = await repos.runs.getRun(scheduled.id);
      expect(fetched?.trigger).toBe("schedule");
      expect(fetched?.scheduleId).toBe("sched-1");
    });

    // ---- Schedules (Phase B) --------------------------------------------
    it("creates + reads a schedule (round-trips kitRef + input + cron)", async () => {
      const created = await repos.schedules.createSchedule(scheduleInput());
      expect(created.enabled).toBe(true);
      expect(created.lastRunAt).toBeNull();
      const fetched = await repos.schedules.getSchedule(created.id);
      expect(fetched?.cron).toBe("*/5 * * * *");
      expect(fetched?.timezone).toBe("UTC");
      expect(fetched?.kitRef).toEqual({ source: "local", localKitId: "k1" });
      expect(fetched?.input.prompt).toBe("do it");
      expect(fetched?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
    });

    it("lists schedules by user", async () => {
      await repos.schedules.createSchedule(scheduleInput());
      await repos.schedules.createSchedule(scheduleInput());
      await repos.schedules.createSchedule(scheduleInput({ userId: "other" }));
      expect((await repos.schedules.listSchedulesByUser("u1")).length).toBe(2);
      expect((await repos.schedules.listSchedulesByUser("other")).length).toBe(1);
    });

    it("selects only enabled + due schedules", async () => {
      const due = await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      // Not yet due.
      await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2099-01-01T00:00:00.000Z" }),
      );
      // Due but disabled.
      await repos.schedules.createSchedule(
        scheduleInput({ enabled: false, nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      const dueList = await repos.schedules.listDueSchedules("2026-06-18T00:01:00.000Z");
      expect(dueList.map((s) => s.id)).toEqual([due.id]);
    });

    it("disabling a schedule removes it from the due set", async () => {
      const created = await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      expect((await repos.schedules.listDueSchedules(NOW)).length).toBe(1);
      const updated = await repos.schedules.updateSchedule(created.id, {
        enabled: false,
        updatedAt: NOW,
      });
      expect(updated?.enabled).toBe(false);
      expect((await repos.schedules.listDueSchedules(NOW)).length).toBe(0);
    });

    it("records a fire result (advances nextRunAt; stamps lastRunId/lastError)", async () => {
      const created = await repos.schedules.createSchedule(
        scheduleInput({ nextRunAt: "2026-06-18T00:00:00.000Z" }),
      );
      await repos.schedules.setScheduleRunResult(created.id, {
        lastRunAt: NOW,
        lastRunId: "run-xyz",
        nextRunAt: "2026-06-18T00:05:00.000Z",
        lastError: null,
      });
      const fetched = await repos.schedules.getSchedule(created.id);
      expect(fetched?.lastRunId).toBe("run-xyz");
      expect(fetched?.nextRunAt).toBe("2026-06-18T00:05:00.000Z");
      expect(fetched?.lastError).toBeNull();
      // Advanced past now → no longer due.
      expect((await repos.schedules.listDueSchedules("2026-06-18T00:01:00.000Z")).length).toBe(0);
    });

    it("deletes a schedule", async () => {
      const created = await repos.schedules.createSchedule(scheduleInput());
      await repos.schedules.deleteSchedule(created.id);
      expect(await repos.schedules.getSchedule(created.id)).toBeUndefined();
    });

    // ---- Approvals: Phase C networkPolicy round-trip --------------------
    it("round-trips an allowlist networkPolicy on an approval", async () => {
      const created = await repos.approvals.createApproval(
        approvalInput({
          toolAllowlist: ["read_file", "http_fetch"],
          networkPolicy: { mode: "allowlist", hosts: ["api.example.com", "*.svc.example.com"] },
        }),
      );
      const found = await repos.approvals.getApprovalForKit("u1", {
        source: "local",
        localKitId: "k1",
      });
      expect(found?.networkPolicy).toEqual({
        mode: "allowlist",
        hosts: ["api.example.com", "*.svc.example.com"],
      });
      expect(found?.id).toBe(created.id);
    });

    // ---- Runs: Phase C webhook trigger + inputFiles back-compat ----------
    it("round-trips a webhook-trigger run with inputFiles", async () => {
      const run = await repos.runs.createRun(
        runInput({
          trigger: "webhook",
          webhookId: "wh-1",
          inputFiles: [{ path: "inputs/data.csv", s3Key: "auto-inputs/run/data.csv" }],
        }),
      );
      const fetched = await repos.runs.getRun(run.id);
      expect(fetched?.trigger).toBe("webhook");
      expect(fetched?.webhookId).toBe("wh-1");
      expect(fetched?.inputFiles?.[0]?.path).toBe("inputs/data.csv");
      expect(fetched?.inputFiles?.[0]?.s3Key).toBe("auto-inputs/run/data.csv");
    });

    // ---- Webhooks (Phase C) ---------------------------------------------
    it("creates + reads a webhook (stores only the secret hash)", async () => {
      const created = await repos.webhooks.createWebhook(webhookInput());
      expect(created.enabled).toBe(true);
      expect(created.fireCount).toBe(0);
      expect(created.lastFiredAt).toBeNull();
      expect(created.secretHash).toBe(hashWebhookSecret("the-secret"));
      const fetched = await repos.webhooks.getWebhook(created.id);
      expect(fetched?.kitRef).toEqual({ source: "local", localKitId: "k1" });
      expect(fetched?.budgetCents).toBe(200);
    });

    it("lists webhooks by user", async () => {
      await repos.webhooks.createWebhook(webhookInput());
      await repos.webhooks.createWebhook(webhookInput());
      await repos.webhooks.createWebhook(webhookInput({ userId: "other" }));
      expect((await repos.webhooks.listWebhooksByUser("u1")).length).toBe(2);
      expect((await repos.webhooks.listWebhooksByUser("other")).length).toBe(1);
    });

    it("records a fire additively (++fireCount, stamps lastRunId/lastFiredAt)", async () => {
      const created = await repos.webhooks.createWebhook(webhookInput());
      await repos.webhooks.recordFire(created.id, {
        lastFiredAt: NOW,
        lastRunId: "run-a",
        lastError: null,
      });
      await repos.webhooks.recordFire(created.id, {
        lastFiredAt: NOW,
        lastRunId: "run-b",
        lastError: "boom",
      });
      const fetched = await repos.webhooks.getWebhook(created.id);
      expect(fetched?.fireCount).toBe(2);
      expect(fetched?.lastRunId).toBe("run-b");
      expect(fetched?.lastError).toBe("boom");
    });

    it("enables/disables a webhook (getWebhook returns it regardless of state)", async () => {
      const created = await repos.webhooks.createWebhook(webhookInput());
      const disabled = await repos.webhooks.setEnabled(created.id, false);
      expect(disabled?.enabled).toBe(false);
      // Still retrievable when disabled (consumeWebhook enforces the check).
      expect((await repos.webhooks.getWebhook(created.id))?.enabled).toBe(false);
      const reEnabled = await repos.webhooks.setEnabled(created.id, true);
      expect(reEnabled?.enabled).toBe(true);
    });

    it("deletes a webhook", async () => {
      const created = await repos.webhooks.createWebhook(webhookInput());
      await repos.webhooks.deleteWebhook(created.id);
      expect(await repos.webhooks.getWebhook(created.id)).toBeUndefined();
    });

    // =====================================================================
    // Event-driven expansion stores
    // =====================================================================

    // ---- Triggers ---------------------------------------------------------
    it("creates + reads a trigger (round-trips config/mapping/filters; defaults applied)", async () => {
      const created = await repos.events.triggers.createTrigger(
        triggerInput({
          filters: [{ path: "action", op: "eq", value: "opened" }],
          destinations: [{ type: "email", to: ["a@example.com"] }],
        }),
      );
      expect(created.enabled).toBe(true);
      expect(created.fireCount).toBe(0);
      expect(created.cursor).toBeNull();
      expect(created.circuit).toEqual({ consecutiveFailures: 0, pausedAt: null });
      const fetched = await repos.events.triggers.getTrigger(created.id);
      expect(fetched?.type).toBe("event");
      expect(fetched?.config).toEqual({ sourceId: "src-1", eventName: "deploy" });
      expect(fetched?.mapping.promptTemplate).toBe("Handle {{action}}");
      expect(fetched?.filters).toEqual([{ path: "action", op: "eq", value: "opened" }]);
      expect(fetched?.destinations).toEqual([{ type: "email", to: ["a@example.com"] }]);
      expect(fetched?.rateLimit).toEqual({ maxPerHour: 20 });
      expect(fetched?.kitRef).toEqual({ source: "local", localKitId: "k1" });
    });

    it("lists triggers by user", async () => {
      await repos.events.triggers.createTrigger(triggerInput());
      await repos.events.triggers.createTrigger(triggerInput());
      await repos.events.triggers.createTrigger(triggerInput({ userId: "other" }));
      expect((await repos.events.triggers.listTriggersByUser("u1")).length).toBe(2);
      expect((await repos.events.triggers.listTriggersByUser("other")).length).toBe(1);
    });

    it("updateTrigger edits fields but never type or circuit", async () => {
      const created = await repos.events.triggers.createTrigger(triggerInput());
      await repos.events.triggers.recordCircuitFailure(created.id);
      const updated = await repos.events.triggers.updateTrigger(created.id, {
        name: "renamed",
        enabled: false,
        config: { sourceId: "src-2", eventName: null },
        updatedAt: "2026-06-18T01:00:00.000Z",
      });
      expect(updated?.name).toBe("renamed");
      expect(updated?.enabled).toBe(false);
      expect(updated?.type).toBe("event");
      expect(updated?.config).toEqual({ sourceId: "src-2", eventName: null });
      expect(updated?.updatedAt).toBe("2026-06-18T01:00:00.000Z");
      // circuit untouched by updateTrigger.
      expect(updated?.circuit.consecutiveFailures).toBe(1);
    });

    it("listDue('schedule') = enabled, non-paused, cursor null-or-due; type-filtered", async () => {
      const due = await repos.events.triggers.createTrigger(
        triggerInput({ type: "schedule", config: { cron: "*/5 * * * *" } }),
      );
      // cursor in the future → not due.
      const future = await repos.events.triggers.createTrigger(
        triggerInput({ type: "schedule", config: { cron: "*/5 * * * *" } }),
      );
      await repos.events.triggers.updateCursor(future.id, "2099-01-01T00:00:00.000Z");
      // cursor in the past → due.
      const past = await repos.events.triggers.createTrigger(
        triggerInput({ type: "schedule", config: { cron: "*/5 * * * *" } }),
      );
      await repos.events.triggers.updateCursor(past.id, "2026-06-17T00:00:00.000Z");
      // disabled → never due.
      await repos.events.triggers.createTrigger(
        triggerInput({ type: "schedule", config: { cron: "*/5 * * * *" }, enabled: false }),
      );
      // circuit-paused → never due.
      const paused = await repos.events.triggers.createTrigger(
        triggerInput({ type: "schedule", config: { cron: "*/5 * * * *" } }),
      );
      await repos.events.triggers.setCircuitPaused(paused.id, NOW);
      // event-type triggers never appear in the schedule due set.
      await repos.events.triggers.createTrigger(triggerInput());

      const dueList = await repos.events.triggers.listDue("schedule", NOW);
      expect(dueList.map((t) => t.id).sort()).toEqual([due.id, past.id].sort());

      // Polled types: every enabled, non-paused trigger of the type is due.
      const eventDue = await repos.events.triggers.listDue("event", NOW);
      expect(eventDue.length).toBe(1);
    });

    it("recordFire stamps lastFiredAt/lastRunId and increments fireCount", async () => {
      const created = await repos.events.triggers.createTrigger(triggerInput());
      await repos.events.triggers.recordFire(created.id, {
        lastFiredAt: NOW,
        lastRunId: "run-1",
        lastError: null,
      });
      await repos.events.triggers.recordFire(created.id, {
        lastFiredAt: NOW,
        lastRunId: "run-2",
        lastError: null,
      });
      const fetched = await repos.events.triggers.getTrigger(created.id);
      expect(fetched?.fireCount).toBe(2);
      expect(fetched?.lastRunId).toBe("run-2");
      expect(fetched?.lastFiredAt).toBe(NOW);
    });

    it("circuit ops: failure count increments, pause excludes from due, reset clears", async () => {
      const created = await repos.events.triggers.createTrigger(
        triggerInput({ type: "schedule", config: { cron: "*/5 * * * *" } }),
      );
      expect(await repos.events.triggers.recordCircuitFailure(created.id)).toBe(1);
      expect(await repos.events.triggers.recordCircuitFailure(created.id)).toBe(2);
      await repos.events.triggers.setCircuitPaused(created.id, NOW);
      expect((await repos.events.triggers.getTrigger(created.id))?.circuit).toEqual({
        consecutiveFailures: 2,
        pausedAt: NOW,
      });
      expect((await repos.events.triggers.listDue("schedule", NOW)).length).toBe(0);
      await repos.events.triggers.resetCircuit(created.id);
      expect((await repos.events.triggers.getTrigger(created.id))?.circuit).toEqual({
        consecutiveFailures: 0,
        pausedAt: null,
      });
      expect((await repos.events.triggers.listDue("schedule", NOW)).length).toBe(1);
    });

    it("deletes a trigger", async () => {
      const created = await repos.events.triggers.createTrigger(triggerInput());
      await repos.events.triggers.deleteTrigger(created.id);
      expect(await repos.events.triggers.getTrigger(created.id)).toBeUndefined();
    });

    // ---- Event sources ----------------------------------------------------
    it("creates + reads an event source (stores only the token hash)", async () => {
      const created = await repos.events.eventSources.createEventSource(eventSourceInput());
      expect(created.enabled).toBe(true);
      expect(created.eventCount).toBe(0);
      expect(created.tokenHash).toBe(hashWebhookSecret("the-token"));
      const fetched = await repos.events.eventSources.getEventSource(created.id);
      expect(fetched?.kind).toBe("custom");
      expect(fetched?.hasSigningSecret).toBe(false);
    });

    it("finds a source by token hash (ingest auth lookup) regardless of enabled state", async () => {
      const created = await repos.events.eventSources.createEventSource(eventSourceInput());
      await repos.events.eventSources.updateEventSource(created.id, { enabled: false });
      const found = await repos.events.eventSources.findByTokenHash(
        hashWebhookSecret("the-token"),
      );
      expect(found?.id).toBe(created.id);
      expect(found?.enabled).toBe(false);
      expect(
        await repos.events.eventSources.findByTokenHash(hashWebhookSecret("nope")),
      ).toBeUndefined();
    });

    it("rotates the token hash via updateEventSource", async () => {
      const created = await repos.events.eventSources.createEventSource(eventSourceInput());
      const rotated = hashWebhookSecret("rotated-token");
      await repos.events.eventSources.updateEventSource(created.id, { tokenHash: rotated });
      expect(
        (await repos.events.eventSources.findByTokenHash(rotated))?.id,
      ).toBe(created.id);
      expect(
        await repos.events.eventSources.findByTokenHash(hashWebhookSecret("the-token")),
      ).toBeUndefined();
    });

    it("records events additively and lists sources by user", async () => {
      const created = await repos.events.eventSources.createEventSource(eventSourceInput());
      await repos.events.eventSources.createEventSource(
        eventSourceInput({ userId: "other", tokenHash: hashWebhookSecret("t2") }),
      );
      await repos.events.eventSources.recordEvent(created.id, NOW);
      await repos.events.eventSources.recordEvent(created.id, "2026-06-18T00:01:00.000Z");
      const fetched = await repos.events.eventSources.getEventSource(created.id);
      expect(fetched?.eventCount).toBe(2);
      expect(fetched?.lastEventAt).toBe("2026-06-18T00:01:00.000Z");
      expect((await repos.events.eventSources.listEventSourcesByUser("u1")).length).toBe(1);
    });

    it("deletes an event source", async () => {
      const created = await repos.events.eventSources.createEventSource(eventSourceInput());
      await repos.events.eventSources.deleteEventSource(created.id);
      expect(await repos.events.eventSources.getEventSource(created.id)).toBeUndefined();
    });

    // ---- Received events (inspector ring buffer) --------------------------
    it("appends + lists received events newest-first and round-trips payloads", async () => {
      await repos.events.receivedEvents.appendEvent({
        sourceId: "src-1",
        name: "deploy",
        receivedAt: "2026-06-18T00:00:01.000Z",
        payload: { n: 1, nested: { deep: true } },
      });
      const second = await repos.events.receivedEvents.appendEvent({
        sourceId: "src-1",
        name: "deploy",
        receivedAt: "2026-06-18T00:00:02.000Z",
        payload: "a bare string payload",
      });
      const listed = await repos.events.receivedEvents.listEventsBySource("src-1");
      expect(listed.length).toBe(2);
      expect(listed[0]?.id).toBe(second.id); // newest first
      expect(listed[0]?.payload).toBe("a bare string payload");
      expect(listed[1]?.payload).toEqual({ n: 1, nested: { deep: true } });
      expect((await repos.events.receivedEvents.getEvent(second.id))?.name).toBe("deploy");
    });

    it("enforces the per-source ring-buffer cap on append (newest kept)", async () => {
      // 105 appends with increasing timestamps → only the newest 100 survive.
      for (let i = 0; i < 105; i++) {
        await repos.events.receivedEvents.appendEvent({
          sourceId: "src-ring",
          name: "tick",
          receivedAt: `2026-06-18T00:00:00.${String(i).padStart(3, "0")}Z`,
          payload: { i },
        });
      }
      const listed = await repos.events.receivedEvents.listEventsBySource("src-ring", 200);
      expect(listed.length).toBe(100);
      // Newest first: i = 104 down to i = 5 (0..4 evicted).
      expect((listed[0]?.payload as { i: number }).i).toBe(104);
      expect((listed[99]?.payload as { i: number }).i).toBe(5);
      // Other sources are unaffected.
      await repos.events.receivedEvents.appendEvent({
        sourceId: "src-other",
        name: "tick",
        receivedAt: NOW,
        payload: null,
      });
      expect((await repos.events.receivedEvents.listEventsBySource("src-other")).length).toBe(1);
    });

    // ---- Fire logs ---------------------------------------------------------
    it("appends + lists fire logs newest-first (nullable runId/detail)", async () => {
      await repos.events.fireLogs.appendFireLog({
        triggerId: "trig-1",
        at: "2026-06-18T00:00:01.000Z",
        outcome: "filtered",
        detail: "Event did not match filter 0.",
      });
      const second = await repos.events.fireLogs.appendFireLog({
        triggerId: "trig-1",
        at: "2026-06-18T00:00:02.000Z",
        outcome: "run_created",
        runId: "run-9",
      });
      const listed = await repos.events.fireLogs.listFireLogsByTrigger("trig-1");
      expect(listed.length).toBe(2);
      expect(listed[0]?.id).toBe(second.id);
      expect(listed[0]?.runId).toBe("run-9");
      expect(listed[0]?.detail).toBeNull();
      expect(listed[1]?.outcome).toBe("filtered");
      expect(listed[1]?.runId).toBeNull();
    });

    it("enforces the per-trigger fire-log cap on append", async () => {
      // The production cap is 500; drive a small custom-cap repository when the
      // harness offers one, else prove the invariant boundary cheaply: append
      // cap+5 rows and expect exactly cap to remain. To keep the suite fast we
      // only run the full 505-row sweep against the in-memory-ish pg-mem
      // harness; dynamodb-local handles it too but slower (acceptable in CI).
      const CAP = 500;
      for (let i = 0; i < CAP + 5; i++) {
        await repos.events.fireLogs.appendFireLog({
          triggerId: "trig-cap",
          at: `2026-06-18T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
          outcome: "suppressed_rate",
        });
      }
      const listed = await repos.events.fireLogs.listFireLogsByTrigger("trig-cap", CAP + 10);
      expect(listed.length).toBe(CAP);
      // Newest kept: the very first (oldest) rows were evicted.
      expect(listed[listed.length - 1]?.at).not.toBe("2026-06-18T00:00:00.000Z");
    }, 60_000);

    // ---- SecretStore (AES-256-GCM; AUTO_SECRET_ENCRYPTION_KEY) -------------
    const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
    const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

    it("round-trips a secret (put/reveal/delete) with a configured key", async () => {
      const prev = process.env["AUTO_SECRET_ENCRYPTION_KEY"];
      process.env["AUTO_SECRET_ENCRYPTION_KEY"] = TEST_KEY;
      try {
        const ref = await repos.events.secrets.put("hmac-signing-secret");
        expect(ref).toBeTruthy();
        expect(await repos.events.secrets.reveal(ref)).toBe("hmac-signing-secret");
        await repos.events.secrets.delete(ref);
        await expect(repos.events.secrets.reveal(ref)).rejects.toThrow();
      } finally {
        if (prev === undefined) delete process.env["AUTO_SECRET_ENCRYPTION_KEY"];
        else process.env["AUTO_SECRET_ENCRYPTION_KEY"] = prev;
      }
    });

    it("reveal with the WRONG key fails; no key throws the typed unconfigured error", async () => {
      const prev = process.env["AUTO_SECRET_ENCRYPTION_KEY"];
      try {
        process.env["AUTO_SECRET_ENCRYPTION_KEY"] = TEST_KEY;
        const ref = await repos.events.secrets.put("s3cret");
        // Wrong key → GCM auth failure.
        process.env["AUTO_SECRET_ENCRYPTION_KEY"] = OTHER_KEY;
        await expect(repos.events.secrets.reveal(ref)).rejects.toThrow();
        // Unset key → typed unconfigured error (name check keeps it decoupled
        // from the import path).
        delete process.env["AUTO_SECRET_ENCRYPTION_KEY"];
        await expect(repos.events.secrets.put("x")).rejects.toMatchObject({
          name: "SecretStoreUnconfiguredError",
        });
      } finally {
        if (prev === undefined) delete process.env["AUTO_SECRET_ENCRYPTION_KEY"];
        else process.env["AUTO_SECRET_ENCRYPTION_KEY"] = prev;
      }
    });

    it("stores + reads back the INTERNAL signing-secret ref (never on the domain shape)", async () => {
      const created = await repos.events.eventSources.createEventSource(
        eventSourceInput({
          kind: "provider",
          provider: "github",
          hasSigningSecret: true,
          signingSecretRef: "ref-abc",
          tokenHash: hashWebhookSecret("gh-token"),
        }),
      );
      expect(created.hasSigningSecret).toBe(true);
      // The ref never appears on the EventSource shape…
      expect((created as Record<string, unknown>)["signingSecretRef"]).toBeUndefined();
      const fetched = await repos.events.eventSources.getEventSource(created.id);
      expect((fetched as unknown as Record<string, unknown>)["signingSecretRef"]).toBeUndefined();
      // …but is retrievable through the internal read.
      expect(await repos.events.eventSources.getSigningSecretRef(created.id)).toBe("ref-abc");
      // Replace + clear semantics.
      await repos.events.eventSources.updateEventSource(created.id, {
        signingSecretRef: "ref-new",
      });
      expect(await repos.events.eventSources.getSigningSecretRef(created.id)).toBe("ref-new");
      await repos.events.eventSources.updateEventSource(created.id, { signingSecretRef: null });
      expect(await repos.events.eventSources.getSigningSecretRef(created.id)).toBeUndefined();
      expect(
        (await repos.events.eventSources.getEventSource(created.id))?.hasSigningSecret,
      ).toBe(false);
    });
  });
}
