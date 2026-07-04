/**
 * Postgres self-host adapter for the Auto core.
 *
 * Implements:
 *   - AutoRunRepository       over Postgres (atomic UPDATE for spend, JSONB
 *                             append for audit via jsonb concatenation).
 *   - AutoApprovalRepository  over Postgres.
 *   - WorkspaceStore          via FsWorkspaceStore on a local disk path (k8s PV).
 *
 * Uses the standard `pg` Pool interface — no ORM, raw SQL. Schema in schema.sql.
 * Mirrors agentkitgateway-core / agentkitmarket-core selfhost adapters.
 */

import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";
import * as os from "node:os";
import type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  AutoWebhookRepository,
  ConnectionRepository,
  EventSourceRepository,
  FireLogRepository,
  InputStore,
  OutputStore,
  PendingApprovalRepository,
  ReceivedEventRepository,
  ScheduleRunResult,
  SecretStore,
  TriggerRepository,
} from "../../core/ports.js";
import type {
  AppendFireLogInput,
  AppendReceivedEventInput,
  AuditEntry,
  AutoApproval,
  AutoRun,
  AutoRunInput,
  AutoRunInputFileRef,
  AutoRunOutputFile,
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  AutoWebhook,
  Connection,
  ConnectionOwnerType,
  ConnectionStatus,
  CreateApprovalInput,
  CreateConnectionInput,
  CreateRunInput,
  CreateScheduleInput,
  CreateTriggerInput,
  CreateWebhookInput,
  CreateEventSourceInput,
  CreatePendingApprovalInput,
  EventSource,
  KitRef,
  PendingTriggerApproval,
  ReceivedEvent,
  Trigger,
  TriggerFireLog,
  TriggerFireRecord,
  TriggerType,
  UpdateConnectionInput,
  UpdateEventSourceInput,
  UpdateScheduleInput,
  UpdateTriggerInput,
  WebhookFireResult,
} from "../../core/types.js";
import { kitRefKey, normalizeNetworkPolicy } from "../../core/types.js";
import type {
  RoyaltyAccrualStore,
  UnaccruedRoyalty,
} from "../../core/royalty-reconciliation.js";
import {
  FIRE_LOGS_PER_TRIGGER_CAP,
  RECEIVED_EVENTS_PER_SOURCE_CAP,
  RECEIVED_EVENT_TTL_MS,
} from "../../core/event-limits.js";
import {
  decryptSecret,
  encryptSecret,
  loadSecretEncryptionKey,
} from "../../core/secret-crypto.js";
import { S3Client } from "@aws-sdk/client-s3";
import { FsWorkspaceStore } from "../../core/fs-workspace.js";
import { LocalInputStore } from "../../core/input-store.js";
import { S3OutputStore } from "../aws/s3-output-store.js";

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

/** pg returns JSONB as parsed objects; pg-mem may return strings. Normalize. */
function asJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function rowToRun(row: Record<string, unknown>): AutoRun {
  const run: AutoRun = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    status: row["status"] as AutoRunStatus,
    input: asJson<AutoRun["input"]>(row["input"]),
    budgetCents: Number(row["budget_cents"]),
    spentCents: Number(row["spent_cents"]),
    spentInferenceCents: Number(row["spent_inference_cents"] ?? 0),
    spentComputeCents: Number(row["spent_compute_cents"] ?? 0),
    inferenceMode: (row["inference_mode"] as AutoRun["inferenceMode"]) ?? "managed",
    isCloudRun: row["is_cloud_run"] === true || row["is_cloud_run"] === "true",
    cloudRunCentsPerMin: Number(row["cloud_run_cents_per_min"] ?? 0),
    model: row["model"] as string,
    createdAt: row["created_at"] as string,
    auditLog: asJson<AuditEntry[]>(row["audit_log"] ?? "[]"),
    cancelRequested: row["cancel_requested"] === true || row["cancel_requested"] === "true",
    trigger: (row["trigger"] as AutoRun["trigger"]) ?? "on_demand",
  };
  if (row["schedule_id"]) run.scheduleId = row["schedule_id"] as string;
  if (row["webhook_id"]) run.webhookId = row["webhook_id"] as string;
  if (row["trigger_id"]) run.triggerId = row["trigger_id"] as string;
  if (row["input_files"]) run.inputFiles = asJson<AutoRunInputFileRef[]>(row["input_files"]);
  if (row["output_files"]) run.outputFiles = asJson<AutoRunOutputFile[]>(row["output_files"]);
  if (row["started_at"]) run.startedAt = row["started_at"] as string;
  if (row["finished_at"]) run.finishedAt = row["finished_at"] as string;
  if (row["error"]) run.error = row["error"] as string;
  if (row["workspace_id"]) run.workspaceId = row["workspace_id"] as string;
  if (row["result"]) run.result = asJson<AutoRunResult>(row["result"]);
  return run;
}

function rowToApproval(row: Record<string, unknown>): AutoApproval {
  return {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    scope: row["scope"] as AutoApproval["scope"],
    toolAllowlist: asJson<string[]>(row["tool_allowlist"]),
    // network_policy is stored as JSONB (Phase C); legacy rows may hold the bare
    // string "deny_all". normalizeNetworkPolicy handles both → object shape.
    networkPolicy: normalizeNetworkPolicy(asJson<unknown>(row["network_policy"])),
    maxBudgetCents: Number(row["max_budget_cents"]),
    createdAt: row["created_at"] as string,
    revokedAt: (row["revoked_at"] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Postgres AutoRunRepository
// ---------------------------------------------------------------------------

export class PostgresAutoRunRepository implements AutoRunRepository {
  constructor(private readonly pool: PgPool) {}

  async createRun(input: CreateRunInput): Promise<AutoRun> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_runs
         (id, user_id, kit_ref, status, input, budget_cents, spent_cents,
          spent_inference_cents, spent_compute_cents, inference_mode,
          is_cloud_run, cloud_run_cents_per_min, model, created_at, audit_log, cancel_requested,
          trigger, schedule_id, webhook_id, input_files, trigger_id)
       VALUES ($1,$2,$3,'queued',$4,$5,0,0,0,$6,$7,$8,$9,$10,$11,FALSE,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        JSON.stringify(input.input),
        input.budgetCents,
        input.inferenceMode ?? "managed",
        input.isCloudRun ?? false,
        input.cloudRunCentsPerMin ?? 0,
        input.model,
        input.createdAt,
        "[]",
        input.trigger ?? "on_demand",
        input.scheduleId ?? null,
        input.webhookId ?? null,
        input.inputFiles ? JSON.stringify(input.inputFiles) : null,
        input.triggerId ?? null,
      ],
    );
    return rowToRun(rows[0]!);
  }

  async getRun(runId: string): Promise<AutoRun | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_runs WHERE id = $1", [runId]);
    return rows[0] ? rowToRun(rows[0]) : undefined;
  }

  async listRunsByUser(userId: string, limit = 50): Promise<AutoRun[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    return rows.map(rowToRun);
  }

  /** L4 concurrency-cap read: ACTIVE (queued/running) runs for the user. */
  async countActiveRuns(userId: string): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*) AS n FROM auto_runs WHERE user_id = $1 AND status IN ('queued', 'running')",
      [userId],
    );
    // COUNT comes back as a bigint string from pg; Number() covers both.
    return Number(rows[0]?.["n"] ?? 0);
  }

  async updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields: {
      startedAt?: string;
      finishedAt?: string;
      error?: string;
      workspaceId?: string;
      spentInferenceCents?: number;
      spentComputeCents?: number;
    } = {},
  ): Promise<AutoRun | undefined> {
    const sets = ["status = $2"];
    const params: unknown[] = [runId, status];
    const colMap: Record<string, string> = {
      startedAt: "started_at",
      finishedAt: "finished_at",
      error: "error",
      workspaceId: "workspace_id",
      spentInferenceCents: "spent_inference_cents",
      spentComputeCents: "spent_compute_cents",
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${colMap[k]} = $${params.length}`);
    }
    const { rows } = await this.pool.query(
      `UPDATE auto_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToRun(rows[0]) : undefined;
  }

  async appendAudit(runId: string, entry: AuditEntry): Promise<void> {
    // Read-modify-write the JSONB array. Portable across real Postgres and
    // pg-mem (whose `||`/`jsonb_insert` jsonb operators are limited). Audit
    // appends are low-frequency, so a round-trip per entry is acceptable.
    const { rows } = await this.pool.query("SELECT audit_log FROM auto_runs WHERE id = $1", [runId]);
    if (!rows[0]) return;
    const current = asJson<AuditEntry[]>(rows[0]["audit_log"] ?? "[]");
    current.push(entry);
    await this.pool.query("UPDATE auto_runs SET audit_log = $2 WHERE id = $1", [
      runId,
      JSON.stringify(current),
    ]);
  }

  async setResult(runId: string, result: AutoRunResult): Promise<void> {
    await this.pool.query("UPDATE auto_runs SET result = $2 WHERE id = $1", [
      runId,
      JSON.stringify(result),
    ]);
  }

  /** Persisted-output manifest write (worker harness, post-terminal). */
  async setOutputFiles(runId: string, files: AutoRunOutputFile[]): Promise<void> {
    await this.pool.query("UPDATE auto_runs SET output_files = $2 WHERE id = $1", [
      runId,
      JSON.stringify(files),
    ]);
  }

  async recordSpend(runId: string, deltaCents: number): Promise<number> {
    const { rows } = await this.pool.query(
      "UPDATE auto_runs SET spent_cents = spent_cents + $2 WHERE id = $1 RETURNING spent_cents",
      [runId, deltaCents],
    );
    return Number(rows[0]?.["spent_cents"] ?? deltaCents);
  }

  async requestCancel(runId: string): Promise<void> {
    await this.pool.query("UPDATE auto_runs SET cancel_requested = TRUE WHERE id = $1", [runId]);
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT cancel_requested FROM auto_runs WHERE id = $1",
      [runId],
    );
    const v = rows[0]?.["cancel_requested"];
    return v === true || v === "true";
  }
}

// ---------------------------------------------------------------------------
// Postgres AutoApprovalRepository
// ---------------------------------------------------------------------------

export class PostgresAutoApprovalRepository implements AutoApprovalRepository {
  constructor(private readonly pool: PgPool) {}

  async createApproval(input: CreateApprovalInput): Promise<AutoApproval> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_approvals
         (id, user_id, kit_ref, user_kit_key, scope, tool_allowlist, network_policy, max_budget_cents, created_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        `${input.userId}#${kitRefKey(input.kitRef)}`,
        input.scope ?? "workspace_read_write",
        JSON.stringify(input.toolAllowlist),
        JSON.stringify(normalizeNetworkPolicy(input.networkPolicy)),
        input.maxBudgetCents,
        input.createdAt,
      ],
    );
    return rowToApproval(rows[0]!);
  }

  async getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_approvals WHERE user_kit_key = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [`${userId}#${kitRefKey(kitRef)}`],
    );
    return rows[0] ? rowToApproval(rows[0]) : undefined;
  }

  async listApprovalsByUser(userId: string): Promise<AutoApproval[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_approvals WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToApproval);
  }

  async revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined> {
    const { rows } = await this.pool.query(
      "UPDATE auto_approvals SET revoked_at = $2 WHERE id = $1 RETURNING *",
      [approvalId, revokedAt],
    );
    return rows[0] ? rowToApproval(rows[0]) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Postgres AutoScheduleRepository (Phase B)
// ---------------------------------------------------------------------------

function rowToSchedule(row: Record<string, unknown>): AutoSchedule {
  const schedule: AutoSchedule = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    cron: row["cron"] as string,
    timezone: row["timezone"] as string,
    input: asJson<AutoRunInput>(row["input"]),
    budgetCents: Number(row["budget_cents"]),
    model: row["model"] as string,
    approvalId: row["approval_id"] as string,
    enabled: row["enabled"] === true || row["enabled"] === "true",
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    lastRunAt: (row["last_run_at"] as string | null) ?? null,
    lastRunId: (row["last_run_id"] as string | null) ?? null,
    nextRunAt: row["next_run_at"] as string,
    lastError: (row["last_error"] as string | null) ?? null,
  };
  if (row["inference_mode"]) {
    schedule.inferenceMode = row["inference_mode"] as AutoSchedule["inferenceMode"];
  }
  return schedule;
}

export class PostgresAutoScheduleRepository implements AutoScheduleRepository {
  constructor(private readonly pool: PgPool) {}

  async createSchedule(input: CreateScheduleInput): Promise<AutoSchedule> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_schedules
         (id, user_id, kit_ref, cron, timezone, input, budget_cents, model,
          approval_id, inference_mode, enabled, created_at, updated_at,
          last_run_at, last_run_id, next_run_at, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,NULL,NULL,$13,NULL)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        input.cron,
        input.timezone ?? "UTC",
        JSON.stringify(input.input),
        input.budgetCents,
        input.model,
        input.approvalId,
        input.inferenceMode ?? null,
        input.enabled ?? true,
        input.createdAt,
        input.nextRunAt,
      ],
    );
    return rowToSchedule(rows[0]!);
  }

  async getSchedule(scheduleId: string): Promise<AutoSchedule | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_schedules WHERE id = $1", [
      scheduleId,
    ]);
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  async listSchedulesByUser(userId: string): Promise<AutoSchedule[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_schedules WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToSchedule);
  }

  async listDueSchedules(nowISO: string): Promise<AutoSchedule[]> {
    // enabled && next_run_at <= now. Indexed on (enabled, next_run_at).
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_schedules WHERE enabled = TRUE AND next_run_at <= $1 ORDER BY next_run_at ASC",
      [nowISO],
    );
    return rows.map(rowToSchedule);
  }

  async updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined> {
    const sets = ["updated_at = $2"];
    const params: unknown[] = [scheduleId, patch.updatedAt];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.cron !== undefined) push("cron", patch.cron);
    if (patch.timezone !== undefined) push("timezone", patch.timezone);
    if (patch.input !== undefined) push("input", JSON.stringify(patch.input));
    if (patch.budgetCents !== undefined) push("budget_cents", patch.budgetCents);
    if (patch.model !== undefined) push("model", patch.model);
    if (patch.approvalId !== undefined) push("approval_id", patch.approvalId);
    if (patch.inferenceMode !== undefined) push("inference_mode", patch.inferenceMode);
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    if (patch.nextRunAt !== undefined) push("next_run_at", patch.nextRunAt);
    const { rows } = await this.pool.query(
      `UPDATE auto_schedules SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  async setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void> {
    await this.pool.query(
      `UPDATE auto_schedules
         SET last_run_at = $2, last_run_id = $3, next_run_at = $4, last_error = $5
       WHERE id = $1`,
      [scheduleId, result.lastRunAt, result.lastRunId, result.nextRunAt, result.lastError],
    );
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_schedules WHERE id = $1", [scheduleId]);
  }
}

// ---------------------------------------------------------------------------
// Postgres AutoWebhookRepository (Phase C)
// ---------------------------------------------------------------------------

function rowToWebhook(row: Record<string, unknown>): AutoWebhook {
  const webhook: AutoWebhook = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    kitRef: asJson<KitRef>(row["kit_ref"]),
    approvalId: row["approval_id"] as string,
    budgetCents: Number(row["budget_cents"]),
    model: row["model"] as string,
    enabled: row["enabled"] === true || row["enabled"] === "true",
    secretHash: row["secret_hash"] as string,
    createdAt: row["created_at"] as string,
    lastFiredAt: (row["last_fired_at"] as string | null) ?? null,
    lastRunId: (row["last_run_id"] as string | null) ?? null,
    lastError: (row["last_error"] as string | null) ?? null,
    fireCount: Number(row["fire_count"] ?? 0),
  };
  if (row["inference_mode"]) {
    webhook.inferenceMode = row["inference_mode"] as AutoWebhook["inferenceMode"];
  }
  return webhook;
}

export class PostgresAutoWebhookRepository implements AutoWebhookRepository {
  constructor(private readonly pool: PgPool) {}

  async createWebhook(input: CreateWebhookInput): Promise<AutoWebhook> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_webhooks
         (id, user_id, kit_ref, approval_id, budget_cents, model, inference_mode,
          enabled, secret_hash, created_at, last_fired_at, last_run_id, last_error, fire_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,NULL,0)
       RETURNING *`,
      [
        id,
        input.userId,
        JSON.stringify(input.kitRef),
        input.approvalId,
        input.budgetCents,
        input.model,
        input.inferenceMode ?? null,
        input.enabled ?? true,
        input.secretHash,
        input.createdAt,
      ],
    );
    return rowToWebhook(rows[0]!);
  }

  async getWebhook(webhookId: string): Promise<AutoWebhook | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_webhooks WHERE id = $1", [
      webhookId,
    ]);
    return rows[0] ? rowToWebhook(rows[0]) : undefined;
  }

  async listWebhooksByUser(userId: string): Promise<AutoWebhook[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_webhooks WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToWebhook);
  }

  async recordFire(webhookId: string, result: WebhookFireResult): Promise<void> {
    await this.pool.query(
      `UPDATE auto_webhooks
         SET last_fired_at = $2, last_run_id = $3, last_error = $4, fire_count = fire_count + 1
       WHERE id = $1`,
      [webhookId, result.lastFiredAt, result.lastRunId, result.lastError],
    );
  }

  async setEnabled(webhookId: string, enabled: boolean): Promise<AutoWebhook | undefined> {
    const { rows } = await this.pool.query(
      "UPDATE auto_webhooks SET enabled = $2 WHERE id = $1 RETURNING *",
      [webhookId, enabled],
    );
    return rows[0] ? rowToWebhook(rows[0]) : undefined;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_webhooks WHERE id = $1", [webhookId]);
  }
}

// ---------------------------------------------------------------------------
// Postgres TriggerRepository (event-driven expansion)
// ---------------------------------------------------------------------------

function rowToTrigger(row: Record<string, unknown>): Trigger {
  const trigger = {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    name: row["name"] as string,
    type: row["type"] as TriggerType,
    config: asJson<unknown>(row["config"]),
    kitRef: asJson<KitRef>(row["kit_ref"]),
    approvalId: row["approval_id"] as string,
    ...(row["model"] ? { model: row["model"] as string } : {}),
    ...(row["budget_cents"] !== null && row["budget_cents"] !== undefined
      ? { budgetCents: Number(row["budget_cents"]) }
      : {}),
    ...(row["filters"] ? { filters: asJson<Trigger["filters"]>(row["filters"]) } : {}),
    mapping: asJson<Trigger["mapping"]>(row["mapping"]),
    ...(row["destinations"]
      ? { destinations: asJson<Trigger["destinations"]>(row["destinations"]) }
      : {}),
    rateLimit: asJson<Trigger["rateLimit"]>(row["rate_limit"]),
    enabled: row["enabled"] === true || row["enabled"] === "true",
    cursor: (row["poll_cursor"] as string | null) ?? null,
    circuit: {
      consecutiveFailures: Number(row["circuit_failures"] ?? 0),
      pausedAt: (row["circuit_paused_at"] as string | null) ?? null,
    },
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    ...(row["last_fired_at"] ? { lastFiredAt: row["last_fired_at"] as string } : {}),
    ...(row["last_run_id"] ? { lastRunId: row["last_run_id"] as string } : {}),
    ...(row["last_error"] ? { lastError: row["last_error"] as string } : {}),
    fireCount: Number(row["fire_count"] ?? 0),
  } as Trigger;
  return trigger;
}

export class PostgresTriggerRepository implements TriggerRepository {
  constructor(private readonly pool: PgPool) {}

  async createTrigger(input: CreateTriggerInput): Promise<Trigger> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_triggers
         (id, user_id, name, type, config, kit_ref, approval_id, model,
          budget_cents, filters, mapping, destinations, rate_limit, enabled,
          poll_cursor, circuit_failures, circuit_paused_at, created_at, updated_at,
          last_fired_at, last_run_id, last_error, fire_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,0,NULL,$15,$15,NULL,NULL,NULL,0)
       RETURNING *`,
      [
        id,
        input.userId,
        input.name,
        input.type,
        JSON.stringify(input.config),
        JSON.stringify(input.kitRef),
        input.approvalId,
        input.model ?? null,
        input.budgetCents ?? null,
        input.filters ? JSON.stringify(input.filters) : null,
        JSON.stringify(input.mapping),
        input.destinations ? JSON.stringify(input.destinations) : null,
        JSON.stringify(input.rateLimit ?? { maxPerHour: 20 }),
        input.enabled ?? true,
        input.createdAt,
      ],
    );
    return rowToTrigger(rows[0]!);
  }

  async getTrigger(triggerId: string): Promise<Trigger | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_triggers WHERE id = $1", [
      triggerId,
    ]);
    return rows[0] ? rowToTrigger(rows[0]) : undefined;
  }

  async listTriggersByUser(userId: string): Promise<Trigger[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_triggers WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToTrigger);
  }

  /**
   * Enabled, non-circuit-paused triggers of `type` due at nowISO. For type
   * "schedule" dueness = cursor (next-fire ISO) <= now, with a NULL cursor
   * (never initialized) treated as due; for polled types every enabled trigger
   * of the type is due each sweep. Indexed on (type, enabled, cursor) —
   * consistent with auto_schedules' (enabled, next_run_at) due index.
   */
  async listDue(type: TriggerType, nowISO: string): Promise<Trigger[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM auto_triggers
        WHERE type = $1 AND enabled = TRUE AND circuit_paused_at IS NULL
          AND ($1 <> 'schedule' OR poll_cursor IS NULL OR poll_cursor <= $2)
        ORDER BY created_at ASC`,
      [type, nowISO],
    );
    return rows.map(rowToTrigger);
  }

  async updateTrigger(
    triggerId: string,
    patch: UpdateTriggerInput,
  ): Promise<Trigger | undefined> {
    // `type` is immutable and `circuit` is ONLY written by the circuit ops.
    const sets = ["updated_at = $2"];
    const params: unknown[] = [triggerId, patch.updatedAt];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.approvalId !== undefined) push("approval_id", patch.approvalId);
    if (patch.model !== undefined) push("model", patch.model);
    if (patch.budgetCents !== undefined) push("budget_cents", patch.budgetCents);
    if (patch.filters !== undefined) push("filters", JSON.stringify(patch.filters));
    if (patch.mapping !== undefined) push("mapping", JSON.stringify(patch.mapping));
    if (patch.destinations !== undefined) {
      push("destinations", JSON.stringify(patch.destinations));
    }
    if (patch.rateLimit !== undefined) push("rate_limit", JSON.stringify(patch.rateLimit));
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    if (patch.config !== undefined) push("config", JSON.stringify(patch.config));
    const { rows } = await this.pool.query(
      `UPDATE auto_triggers SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToTrigger(rows[0]) : undefined;
  }

  async recordFire(triggerId: string, result: TriggerFireRecord): Promise<void> {
    await this.pool.query(
      `UPDATE auto_triggers
         SET last_fired_at = $2, last_run_id = $3, last_error = $4, fire_count = fire_count + 1
       WHERE id = $1`,
      [triggerId, result.lastFiredAt, result.lastRunId, result.lastError],
    );
  }

  async updateCursor(triggerId: string, cursor: string | null): Promise<void> {
    await this.pool.query("UPDATE auto_triggers SET poll_cursor = $2 WHERE id = $1", [
      triggerId,
      cursor,
    ]);
  }

  async recordCircuitFailure(triggerId: string): Promise<number> {
    const { rows } = await this.pool.query(
      "UPDATE auto_triggers SET circuit_failures = circuit_failures + 1 WHERE id = $1 RETURNING circuit_failures",
      [triggerId],
    );
    return Number(rows[0]?.["circuit_failures"] ?? 0);
  }

  async resetCircuit(triggerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE auto_triggers SET circuit_failures = 0, circuit_paused_at = NULL WHERE id = $1",
      [triggerId],
    );
  }

  async setCircuitPaused(triggerId: string, pausedAt: string | null): Promise<void> {
    await this.pool.query("UPDATE auto_triggers SET circuit_paused_at = $2 WHERE id = $1", [
      triggerId,
      pausedAt,
    ]);
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_triggers WHERE id = $1", [triggerId]);
  }
}

// ---------------------------------------------------------------------------
// Postgres EventSourceRepository (event-driven expansion)
// ---------------------------------------------------------------------------

function rowToEventSource(row: Record<string, unknown>): EventSource {
  return {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    name: row["name"] as string,
    kind: row["kind"] as EventSource["kind"],
    ...(row["provider"] ? { provider: row["provider"] as EventSource["provider"] } : {}),
    tokenHash: row["token_hash"] as string,
    hasSigningSecret:
      row["has_signing_secret"] === true || row["has_signing_secret"] === "true",
    enabled: row["enabled"] === true || row["enabled"] === "true",
    createdAt: row["created_at"] as string,
    ...(row["last_event_at"] ? { lastEventAt: row["last_event_at"] as string } : {}),
    eventCount: Number(row["event_count"] ?? 0),
  };
}

export class PostgresEventSourceRepository implements EventSourceRepository {
  constructor(private readonly pool: PgPool) {}

  async createEventSource(input: CreateEventSourceInput): Promise<EventSource> {
    const id = randomUUID();
    const signingSecretRef = input.signingSecretRef ?? null;
    const { rows } = await this.pool.query(
      `INSERT INTO auto_event_sources
         (id, user_id, name, kind, provider, token_hash, has_signing_secret,
          signing_secret_ref, enabled, created_at, last_event_at, event_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,0)
       RETURNING *`,
      [
        id,
        input.userId,
        input.name,
        input.kind,
        input.provider ?? null,
        input.tokenHash,
        signingSecretRef !== null ? true : input.hasSigningSecret,
        signingSecretRef,
        input.enabled ?? true,
        input.createdAt,
      ],
    );
    return rowToEventSource(rows[0]!);
  }

  async getEventSource(sourceId: string): Promise<EventSource | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_event_sources WHERE id = $1", [
      sourceId,
    ]);
    return rows[0] ? rowToEventSource(rows[0]) : undefined;
  }

  async listEventSourcesByUser(userId: string): Promise<EventSource[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_event_sources WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(rowToEventSource);
  }

  async findByTokenHash(tokenHash: string): Promise<EventSource | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_event_sources WHERE token_hash = $1 LIMIT 1",
      [tokenHash],
    );
    return rows[0] ? rowToEventSource(rows[0]) : undefined;
  }

  async updateEventSource(
    sourceId: string,
    patch: UpdateEventSourceInput,
  ): Promise<EventSource | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [sourceId];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    if (patch.tokenHash !== undefined) push("token_hash", patch.tokenHash);
    if (patch.signingSecretRef !== undefined) {
      push("signing_secret_ref", patch.signingSecretRef);
      // hasSigningSecret derives from the ref (present -> true).
      push("has_signing_secret", patch.signingSecretRef !== null);
    }
    if (sets.length === 0) return this.getEventSource(sourceId);
    const { rows } = await this.pool.query(
      `UPDATE auto_event_sources SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToEventSource(rows[0]) : undefined;
  }

  async getSigningSecretRef(sourceId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(
      "SELECT signing_secret_ref FROM auto_event_sources WHERE id = $1",
      [sourceId],
    );
    const ref = rows[0]?.["signing_secret_ref"];
    return typeof ref === "string" && ref.length > 0 ? ref : undefined;
  }

  async recordEvent(sourceId: string, receivedAt: string): Promise<void> {
    await this.pool.query(
      "UPDATE auto_event_sources SET last_event_at = $2, event_count = event_count + 1 WHERE id = $1",
      [sourceId, receivedAt],
    );
  }

  async deleteEventSource(sourceId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_event_sources WHERE id = $1", [sourceId]);
  }
}

// ---------------------------------------------------------------------------
// Postgres ReceivedEventRepository (inspector ring buffer)
// ---------------------------------------------------------------------------

function rowToReceivedEvent(row: Record<string, unknown>): ReceivedEvent {
  return {
    id: row["id"] as string,
    sourceId: row["source_id"] as string,
    name: row["name"] as string,
    receivedAt: row["received_at"] as string,
    // Stored JSON-STRINGIFIED (payload_json TEXT) so any JSON value — incl.
    // bare strings/numbers — round-trips identically on pg and pg-mem.
    payload:
      row["payload_json"] === null || row["payload_json"] === undefined
        ? undefined
        : (JSON.parse(row["payload_json"] as string) as unknown),
  };
}

export class PostgresReceivedEventRepository implements ReceivedEventRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly capPerSource = RECEIVED_EVENTS_PER_SOURCE_CAP,
    private readonly ttlMs = RECEIVED_EVENT_TTL_MS,
  ) {}

  async appendEvent(input: AppendReceivedEventInput): Promise<ReceivedEvent> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_received_events (id, source_id, name, received_at, payload_json)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        id,
        input.sourceId,
        input.name,
        input.receivedAt,
        input.payload === undefined ? null : JSON.stringify(input.payload),
      ],
    );
    // Ring-buffer semantics: evict beyond the per-source cap on every append.
    await this.pruneEvents(input.sourceId);
    return rowToReceivedEvent(rows[0]!);
  }

  async listEventsBySource(sourceId: string, limit = 50): Promise<ReceivedEvent[]> {
    // seq is a BIGSERIAL insertion counter: newest-first even when receivedAt ties.
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_received_events WHERE source_id = $1 ORDER BY seq DESC LIMIT $2",
      [sourceId, limit],
    );
    return rows.map(rowToReceivedEvent);
  }

  async getEvent(eventId: string): Promise<ReceivedEvent | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_received_events WHERE id = $1",
      [eventId],
    );
    return rows[0] ? rowToReceivedEvent(rows[0]) : undefined;
  }

  /** Evicts over-cap and past-TTL entries for a source; returns the count. */
  async pruneEvents(sourceId: string): Promise<number> {
    // Fetch ids newest-first and delete the tail — a portable two-step (pg-mem
    // has no DELETE ... IN (subquery) guarantees). One append adds at most one
    // over-cap row, so the tail is tiny in steady state.
    const { rows } = await this.pool.query(
      "SELECT id, received_at FROM auto_received_events WHERE source_id = $1 ORDER BY seq DESC",
      [sourceId],
    );
    const newest = rows[0]?.["received_at"] as string | undefined;
    const ttlCutoffMs = newest !== undefined ? Date.parse(newest) - this.ttlMs : undefined;
    const toDelete: string[] = [];
    rows.forEach((row, index) => {
      const overCap = index >= this.capPerSource;
      const receivedMs = Date.parse(row["received_at"] as string);
      const pastTtl =
        ttlCutoffMs !== undefined && Number.isFinite(receivedMs) && receivedMs < ttlCutoffMs;
      if (overCap || pastTtl) toDelete.push(row["id"] as string);
    });
    for (const id of toDelete) {
      await this.pool.query("DELETE FROM auto_received_events WHERE id = $1", [id]);
    }
    return toDelete.length;
  }
}

// ---------------------------------------------------------------------------
// Postgres FireLogRepository (abuse/cost observability)
// ---------------------------------------------------------------------------

function rowToFireLog(row: Record<string, unknown>): TriggerFireLog {
  return {
    id: row["id"] as string,
    triggerId: row["trigger_id"] as string,
    at: row["fired_at"] as string,
    outcome: row["outcome"] as TriggerFireLog["outcome"],
    runId: (row["run_id"] as string | null) ?? null,
    detail: (row["detail"] as string | null) ?? null,
  };
}

export class PostgresFireLogRepository implements FireLogRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly capPerTrigger = FIRE_LOGS_PER_TRIGGER_CAP,
  ) {}

  async appendFireLog(input: AppendFireLogInput): Promise<TriggerFireLog> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_fire_logs (id, trigger_id, fired_at, outcome, run_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [id, input.triggerId, input.at, input.outcome, input.runId ?? null, input.detail ?? null],
    );
    // Ring-buffer semantics: evict beyond the per-trigger cap on every append.
    const { rows: all } = await this.pool.query(
      "SELECT id FROM auto_fire_logs WHERE trigger_id = $1 ORDER BY seq DESC",
      [input.triggerId],
    );
    for (const row of all.slice(this.capPerTrigger)) {
      await this.pool.query("DELETE FROM auto_fire_logs WHERE id = $1", [row["id"]]);
    }
    return rowToFireLog(rows[0]!);
  }

  async listFireLogsByTrigger(triggerId: string, limit = 100): Promise<TriggerFireLog[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_fire_logs WHERE trigger_id = $1 ORDER BY seq DESC LIMIT $2",
      [triggerId, limit],
    );
    return rows.map(rowToFireLog);
  }
}

// ---------------------------------------------------------------------------
// Postgres ConnectionRepository (non-secret connection records — S2)
// ---------------------------------------------------------------------------

function rowToConnection(row: Record<string, unknown>): Connection {
  return {
    id: row["id"] as string,
    ownerType: row["owner_type"] as Connection["ownerType"],
    ownerId: row["owner_id"] as string,
    name: row["name"] as string,
    type: row["type"] as Connection["type"],
    config: asJson<Connection["config"]>(row["config"]),
    secretRef: (row["secret_ref"] as string | null) ?? null,
    status: (row["status"] as Connection["status"]) ?? "unverified",
    ...(row["last_used_at"] ? { lastUsedAt: row["last_used_at"] as string } : {}),
    createdAt: row["created_at"] as string,
  };
}

export class PostgresConnectionRepository implements ConnectionRepository {
  constructor(private readonly pool: PgPool) {}

  async createConnection(input: CreateConnectionInput): Promise<Connection> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_connections
         (id, owner_type, owner_id, name, type, config, secret_ref, status, last_used_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified',NULL,$8)
       RETURNING *`,
      [
        id,
        input.ownerType,
        input.ownerId,
        input.name,
        input.type,
        JSON.stringify(input.config),
        input.secretRef ?? null,
        input.createdAt,
      ],
    );
    return rowToConnection(rows[0]!);
  }

  async getConnection(connectionId: string): Promise<Connection | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM auto_connections WHERE id = $1", [
      connectionId,
    ]);
    return rows[0] ? rowToConnection(rows[0]) : undefined;
  }

  async listConnectionsByOwner(
    ownerType: ConnectionOwnerType,
    ownerId: string,
  ): Promise<Connection[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_connections WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at DESC",
      [ownerType, ownerId],
    );
    return rows.map(rowToConnection);
  }

  async updateConnection(
    connectionId: string,
    patch: UpdateConnectionInput,
  ): Promise<Connection | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [connectionId];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.config !== undefined) push("config", JSON.stringify(patch.config));
    if (patch.secretRef !== undefined) push("secret_ref", patch.secretRef);
    if (sets.length === 0) return this.getConnection(connectionId);
    const { rows } = await this.pool.query(
      `UPDATE auto_connections SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return rows[0] ? rowToConnection(rows[0]) : undefined;
  }

  async setConnectionStatus(
    connectionId: string,
    status: ConnectionStatus,
    lastUsedAt?: string,
  ): Promise<void> {
    if (lastUsedAt !== undefined) {
      await this.pool.query(
        "UPDATE auto_connections SET status = $2, last_used_at = $3 WHERE id = $1",
        [connectionId, status, lastUsedAt],
      );
      return;
    }
    await this.pool.query("UPDATE auto_connections SET status = $2 WHERE id = $1", [
      connectionId,
      status,
    ]);
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_connections WHERE id = $1", [connectionId]);
  }
}


// ---------------------------------------------------------------------------
// Postgres PendingApprovalRepository (Wave 4 — held requireApproval fires)
// ---------------------------------------------------------------------------

function rowToPendingApproval(row: Record<string, unknown>): PendingTriggerApproval {
  return {
    id: row["id"] as string,
    triggerId: row["trigger_id"] as string,
    userId: row["user_id"] as string,
    tokenHash: row["token_hash"] as string,
    event: JSON.parse(row["event_json"] as string) as PendingTriggerApproval["event"],
    status: row["status"] as PendingTriggerApproval["status"],
    createdAt: row["created_at"] as string,
    expiresAt: row["expires_at"] as string,
    resolvedAt: (row["resolved_at"] as string | null) ?? null,
  };
}

export class PostgresPendingApprovalRepository implements PendingApprovalRepository {
  constructor(private readonly pool: PgPool) {}

  async createPending(input: CreatePendingApprovalInput): Promise<PendingTriggerApproval> {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO auto_pending_approvals
         (id, trigger_id, user_id, token_hash, event_json, status, created_at, expires_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,NULL)
       RETURNING *`,
      [
        id,
        input.triggerId,
        input.userId,
        input.tokenHash,
        JSON.stringify(input.event),
        input.createdAt,
        input.expiresAt,
      ],
    );
    return rowToPendingApproval(rows[0]!);
  }

  async getPending(pendingId: string): Promise<PendingTriggerApproval | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_pending_approvals WHERE id = $1",
      [pendingId],
    );
    return rows[0] ? rowToPendingApproval(rows[0]) : undefined;
  }

  async findByTokenHash(tokenHash: string): Promise<PendingTriggerApproval | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM auto_pending_approvals WHERE token_hash = $1",
      [tokenHash],
    );
    return rows[0] ? rowToPendingApproval(rows[0]) : undefined;
  }

  async resolvePending(
    pendingId: string,
    status: "approved" | "denied" | "expired",
    resolvedAt: string,
  ): Promise<PendingTriggerApproval | undefined> {
    // Single-consume: flips ONLY from 'pending' (atomic conditional UPDATE).
    const { rows } = await this.pool.query(
      `UPDATE auto_pending_approvals SET status = $2, resolved_at = $3
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [pendingId, status, resolvedAt],
    );
    return rows[0] ? rowToPendingApproval(rows[0]) : undefined;
  }

  async deletePending(pendingId: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_pending_approvals WHERE id = $1", [pendingId]);
  }
}

// ---------------------------------------------------------------------------
// Postgres SecretStore (encrypted-at-rest provider signing secrets — S2)
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM SecretStore over the `auto_secrets` table. The operator key is
 * read LAZILY per call from AUTO_SECRET_ENCRYPTION_KEY, so an unconfigured
 * deployment only fails (typed SecretStoreUnconfiguredError) when secret
 * storage is actually used — sources without signing secrets are unaffected.
 */
export class PostgresSecretStore implements SecretStore {
  constructor(
    private readonly pool: PgPool,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async put(plaintext: string): Promise<string> {
    const key = loadSecretEncryptionKey(this.env);
    const secretRef = randomUUID();
    const enc = encryptSecret(key, plaintext);
    await this.pool.query(
      `INSERT INTO auto_secrets (secret_ref, ciphertext, iv, tag, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [secretRef, enc.ciphertext, enc.iv, enc.tag, new Date().toISOString()],
    );
    return secretRef;
  }

  async reveal(secretRef: string): Promise<string> {
    const key = loadSecretEncryptionKey(this.env);
    const { rows } = await this.pool.query(
      "SELECT ciphertext, iv, tag FROM auto_secrets WHERE secret_ref = $1",
      [secretRef],
    );
    const row = rows[0];
    if (!row) throw new Error(`Unknown secretRef: ${secretRef}`);
    return decryptSecret(key, {
      ciphertext: row["ciphertext"] as string,
      iv: row["iv"] as string,
      tag: row["tag"] as string,
    });
  }

  async delete(secretRef: string): Promise<void> {
    await this.pool.query("DELETE FROM auto_secrets WHERE secret_ref = $1", [secretRef]);
  }
}

// ---------------------------------------------------------------------------
// Postgres RoyaltyAccrualStore (M6 #5 — durable royalty-accrual reconciliation)
// ---------------------------------------------------------------------------

/**
 * Durable store of buyer-charged royalties whose immediate accrual to the seller
 * did NOT confirm (the run-driver flags `royaltyAccrued === false`; the worker
 * records the intent here). Backed by the `auto_unaccrued_royalties` table over
 * the SAME pool the run repository uses, so the record write happens on the
 * durable worker connection and survives the failed accrual. The periodic
 * reconciliation job re-drives these through the idempotent gateway
 * `accrueRoyalty`.
 *
 * Semantics match the tested `InMemoryRoyaltyAccrualStore` reference exactly:
 *   - recordUnaccrued is idempotent on runId (first-write-wins via ON CONFLICT).
 *   - listUnaccrued returns not-yet-accrued rows oldest-first.
 *   - markAccrued stamps accrued_at (idempotent).
 *   - markError records the latest error ONLY while still pending (accrued_at IS NULL).
 *
 * INERT on open-core / self-host: the table is created harmlessly, but nothing is
 * ever recorded unless a premium royalty was actually charged and its accrual threw.
 */
export class PostgresRoyaltyAccrualStore implements RoyaltyAccrualStore {
  constructor(private readonly pool: PgPool) {}

  async recordUnaccrued(intent: UnaccruedRoyalty, now: string): Promise<void> {
    // First-write-wins: a re-record of the same runId is a no-op (idempotent).
    await this.pool.query(
      `INSERT INTO auto_unaccrued_royalties
         (run_id, org_id, kit_id, gross_cents, commission_bps, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        intent.runId,
        intent.orgId,
        intent.kitId,
        intent.grossRoyaltyCents,
        intent.commissionBps,
        now,
      ],
    );
  }

  async listUnaccrued(limit: number): Promise<UnaccruedRoyalty[]> {
    const { rows } = await this.pool.query(
      `SELECT run_id, org_id, kit_id, gross_cents, commission_bps
         FROM auto_unaccrued_royalties
        WHERE accrued_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      runId: row["run_id"] as string,
      orgId: row["org_id"] as string,
      kitId: row["kit_id"] as string,
      grossRoyaltyCents: Number(row["gross_cents"]),
      commissionBps: Number(row["commission_bps"] ?? 0),
    }));
  }

  async markAccrued(runId: string, now: string): Promise<void> {
    await this.pool.query(
      "UPDATE auto_unaccrued_royalties SET accrued_at = $2 WHERE run_id = $1",
      [runId, now],
    );
  }

  async markError(runId: string, error: string, _now: string): Promise<void> {
    // Observability only; never overwrite a resolved (accrued) row.
    await this.pool.query(
      "UPDATE auto_unaccrued_royalties SET accrual_error = $2 WHERE run_id = $1 AND accrued_at IS NULL",
      [runId, error],
    );
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface MakeSelfHostAutoDepsOptions {
  pool: PgPool;
  /** Workspace root on a local disk / PV. Defaults to an OS tmp dir. */
  workspaceRootDir?: string;
  /**
   * Phase C input store. Defaults to an in-process LocalInputStore (suitable for
   * single-node self-host where the web layer + worker share a process/disk). A
   * MinIO/S3-backed store can be injected here for multi-node deployments.
   */
  inputs?: InputStore;
  /**
   * Persisted-output store. When omitted, a MinIO/S3-backed S3OutputStore is
   * built from env (AUTO_OUTPUTS_BUCKET + the same S3_ENDPOINT/S3_ACCESS_KEY_ID/
   * S3_SECRET_ACCESS_KEY the kit-tree store uses); when the env is absent too,
   * outputs stay UNDEFINED and the worker skips output persistence silently
   * (deploy-safe).
   */
  outputs?: OutputStore;
}

/**
 * Builds the self-host OutputStore from env: the SAME S3-compatible client the
 * kit-tree store uses, pointed at the bundled MinIO (endpoint + forcePathStyle).
 * Returns undefined (→ persistence skipped) unless AUTO_OUTPUTS_BUCKET AND the
 * S3 endpoint/credentials are configured.
 */
export function makeSelfHostOutputStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): OutputStore | undefined {
  const bucket = env["AUTO_OUTPUTS_BUCKET"]?.trim();
  const endpoint = env["AUTO_OUTPUTS_S3_ENDPOINT"]?.trim() || env["S3_ENDPOINT"]?.trim();
  const accessKeyId = env["S3_ACCESS_KEY_ID"]?.trim();
  const secretAccessKey = env["S3_SECRET_ACCESS_KEY"]?.trim();
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return undefined;
  const client = new S3Client({
    endpoint,
    region: env["AWS_REGION"] || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return new S3OutputStore({ client, bucket, ensureBucket: true });
}

export function makeSelfHostAutoDeps(options: MakeSelfHostAutoDepsOptions): AutoStorageDeps {
  const rootDir =
    options.workspaceRootDir ?? nodePath.join(os.tmpdir(), "agentkitauto-workspaces");
  const outputs = options.outputs ?? makeSelfHostOutputStoreFromEnv();
  return {
    runs: new PostgresAutoRunRepository(options.pool),
    approvals: new PostgresAutoApprovalRepository(options.pool),
    schedules: new PostgresAutoScheduleRepository(options.pool),
    webhooks: new PostgresAutoWebhookRepository(options.pool),
    workspaces: new FsWorkspaceStore({ rootDir }),
    inputs: options.inputs ?? new LocalInputStore(),
    // Persisted run outputs — absent env → undefined (worker skips silently).
    ...(outputs ? { outputs } : {}),
    // Event-driven expansion stores (always populated by this adapter).
    events: {
      triggers: new PostgresTriggerRepository(options.pool),
      eventSources: new PostgresEventSourceRepository(options.pool),
      receivedEvents: new PostgresReceivedEventRepository(options.pool),
      fireLogs: new PostgresFireLogRepository(options.pool),
      secrets: new PostgresSecretStore(options.pool),
      connections: new PostgresConnectionRepository(options.pool),
      pendingApprovals: new PostgresPendingApprovalRepository(options.pool),
    },
  };
}

// ---------------------------------------------------------------------------
// Schema (self-host)
// ---------------------------------------------------------------------------

/**
 * The idempotent CREATE TABLE IF NOT EXISTS schema for the Auto self-host
 * Postgres tables (auto_runs, auto_approvals, auto_schedules, auto_webhooks,
 * plus the event-driven expansion: auto_triggers, auto_event_sources,
 * auto_received_events, auto_fire_logs, auto_secrets).
 *
 * This is the EXACT content of `schema.sql` embedded as a string so it ships in
 * the compiled `dist/` without needing the .sql file at runtime (the worker +
 * web-forge selfhost backend run it on startup via `ensureAutoSchema`). When you
 * edit schema.sql, keep this string in sync (a test asserts they match).
 */
export const AUTO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auto_runs (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  status            TEXT        NOT NULL,
  input             JSONB       NOT NULL,
  budget_cents      INTEGER     NOT NULL,
  spent_cents       INTEGER     NOT NULL DEFAULT 0,
  spent_inference_cents   INTEGER NOT NULL DEFAULT 0,
  spent_compute_cents     INTEGER NOT NULL DEFAULT 0,
  inference_mode          TEXT    NOT NULL DEFAULT 'managed',
  is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE,
  cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0,
  model             TEXT        NOT NULL,
  created_at        TEXT        NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  result            JSONB,
  error             TEXT,
  audit_log         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  workspace_id      TEXT,
  cancel_requested  BOOLEAN     NOT NULL DEFAULT FALSE,
  trigger           TEXT        NOT NULL DEFAULT 'on_demand',
  schedule_id       TEXT,
  webhook_id        TEXT,
  input_files       JSONB
);

CREATE INDEX IF NOT EXISTS auto_runs_user_idx ON auto_runs (user_id, created_at DESC);

ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_inference_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS spent_compute_cents     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS inference_mode          TEXT    NOT NULL DEFAULT 'managed';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS is_cloud_run            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS cloud_run_cents_per_min INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auto_approvals (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  user_kit_key      TEXT        NOT NULL,
  scope             TEXT        NOT NULL,
  tool_allowlist    JSONB       NOT NULL,
  network_policy    JSONB       NOT NULL,
  max_budget_cents  INTEGER     NOT NULL,
  created_at        TEXT        NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS auto_approvals_user_idx ON auto_approvals (user_id);
CREATE INDEX IF NOT EXISTS auto_approvals_user_kit_idx ON auto_approvals (user_kit_key);

ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS trigger     TEXT NOT NULL DEFAULT 'on_demand';
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS schedule_id TEXT;

CREATE TABLE IF NOT EXISTS auto_schedules (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  cron              TEXT        NOT NULL,
  timezone          TEXT        NOT NULL DEFAULT 'UTC',
  input             JSONB       NOT NULL,
  budget_cents      INTEGER     NOT NULL,
  model             TEXT        NOT NULL,
  approval_id       TEXT        NOT NULL,
  inference_mode    TEXT,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TEXT        NOT NULL,
  updated_at        TEXT        NOT NULL,
  last_run_at       TEXT,
  last_run_id       TEXT,
  next_run_at       TEXT        NOT NULL,
  last_error        TEXT
);

CREATE INDEX IF NOT EXISTS auto_schedules_user_idx ON auto_schedules (user_id);
CREATE INDEX IF NOT EXISTS auto_schedules_due_idx ON auto_schedules (enabled, next_run_at);

ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS webhook_id  TEXT;
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS input_files JSONB;

CREATE TABLE IF NOT EXISTS auto_webhooks (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  kit_ref           JSONB       NOT NULL,
  approval_id       TEXT        NOT NULL,
  budget_cents      INTEGER     NOT NULL,
  model             TEXT        NOT NULL,
  inference_mode    TEXT,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  secret_hash       TEXT        NOT NULL,
  created_at        TEXT        NOT NULL,
  last_fired_at     TEXT,
  last_run_id       TEXT,
  last_error        TEXT,
  fire_count        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_webhooks_user_idx ON auto_webhooks (user_id);

-- ---------------------------------------------------------------------------
-- Event-driven expansion: unified triggers + event sources + ring buffers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_triggers (
  id                TEXT        NOT NULL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  type              TEXT        NOT NULL,
  config            JSONB       NOT NULL,
  kit_ref           JSONB       NOT NULL,
  approval_id       TEXT        NOT NULL,
  model             TEXT,
  budget_cents      INTEGER,
  filters           JSONB,
  mapping           JSONB       NOT NULL,
  destinations      JSONB,
  rate_limit        JSONB       NOT NULL,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  poll_cursor       TEXT,
  circuit_failures  INTEGER     NOT NULL DEFAULT 0,
  circuit_paused_at TEXT,
  created_at        TEXT        NOT NULL,
  updated_at        TEXT        NOT NULL,
  last_fired_at     TEXT,
  last_run_id       TEXT,
  last_error        TEXT,
  fire_count        INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_triggers_user_idx ON auto_triggers (user_id);
CREATE INDEX IF NOT EXISTS auto_triggers_due_idx ON auto_triggers (type, enabled, poll_cursor);

CREATE TABLE IF NOT EXISTS auto_event_sources (
  id                  TEXT      NOT NULL PRIMARY KEY,
  user_id             TEXT      NOT NULL,
  name                TEXT      NOT NULL,
  kind                TEXT      NOT NULL,
  provider            TEXT,
  token_hash          TEXT      NOT NULL,
  has_signing_secret  BOOLEAN   NOT NULL DEFAULT FALSE,
  enabled             BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at          TEXT      NOT NULL,
  last_event_at       TEXT,
  event_count         INTEGER   NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auto_event_sources_user_idx ON auto_event_sources (user_id);
CREATE INDEX IF NOT EXISTS auto_event_sources_token_idx ON auto_event_sources (token_hash);

CREATE TABLE IF NOT EXISTS auto_received_events (
  id          TEXT        NOT NULL PRIMARY KEY,
  seq         BIGSERIAL,
  source_id   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  received_at  TEXT       NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS auto_received_events_source_idx ON auto_received_events (source_id, seq);

CREATE TABLE IF NOT EXISTS auto_fire_logs (
  id          TEXT        NOT NULL PRIMARY KEY,
  seq         BIGSERIAL,
  trigger_id  TEXT        NOT NULL,
  fired_at    TEXT        NOT NULL,
  outcome     TEXT        NOT NULL,
  run_id      TEXT,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS auto_fire_logs_trigger_idx ON auto_fire_logs (trigger_id, seq);

-- Idempotent migration: unified-Trigger run provenance (contracts autoRunSchema.triggerId).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS trigger_id TEXT;

CREATE TABLE IF NOT EXISTS auto_secrets (
  secret_ref  TEXT        NOT NULL PRIMARY KEY,
  ciphertext  TEXT        NOT NULL,
  iv          TEXT        NOT NULL,
  tag         TEXT        NOT NULL,
  created_at  TEXT        NOT NULL
);

ALTER TABLE auto_event_sources ADD COLUMN IF NOT EXISTS signing_secret_ref TEXT;

-- Idempotent migration: persisted-output manifest (contracts autoRunSchema.outputFiles).
ALTER TABLE auto_runs ADD COLUMN IF NOT EXISTS output_files JSONB;

CREATE TABLE IF NOT EXISTS auto_connections (
  id           TEXT        NOT NULL PRIMARY KEY,
  owner_type   TEXT        NOT NULL,
  owner_id     TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  type         TEXT        NOT NULL,
  config       JSONB       NOT NULL,
  secret_ref   TEXT,
  status       TEXT        NOT NULL DEFAULT 'unverified',
  last_used_at TEXT,
  created_at   TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS auto_connections_owner_idx ON auto_connections (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS auto_pending_approvals (
  id          TEXT        NOT NULL PRIMARY KEY,
  trigger_id  TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  token_hash  TEXT        NOT NULL,
  event_json  TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending',
  created_at  TEXT        NOT NULL,
  expires_at  TEXT        NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS auto_pending_approvals_token_idx ON auto_pending_approvals (token_hash);
CREATE INDEX IF NOT EXISTS auto_pending_approvals_trigger_idx ON auto_pending_approvals (trigger_id);

-- ---------------------------------------------------------------------------
-- M6 #5 — durable royalty-accrual reconciliation.
-- Records a run whose buyer-charged royalty was NOT accrued to the seller (the
-- immediate accrual threw). The reconciliation job re-drives pending rows
-- (accrued_at IS NULL) through the idempotent gateway accrual. INERT on
-- open-core / self-host: created harmlessly, never written unless a premium
-- royalty was charged and its accrual failed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_unaccrued_royalties (
  run_id          TEXT        NOT NULL PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  kit_id          TEXT        NOT NULL,
  gross_cents     INTEGER     NOT NULL,
  commission_bps  INTEGER     NOT NULL DEFAULT 0,
  created_at      TEXT        NOT NULL,
  accrued_at      TEXT,
  accrual_error   TEXT
);

CREATE INDEX IF NOT EXISTS auto_unaccrued_royalties_pending_idx ON auto_unaccrued_royalties (accrued_at, created_at);

`;

const ensuredAutoSchema = new WeakSet<object>();

/**
 * Idempotently create the Auto self-host schema. Safe to call on every startup /
 * adapter construction (CREATE TABLE / ADD COLUMN IF NOT EXISTS). Memoised per
 * pool so repeated calls are cheap. The web-forge selfhost backend calls this
 * before first use, and the self-host worker entrypoint calls it on boot.
 */
export async function ensureAutoSchema(pool: PgPool): Promise<void> {
  if (ensuredAutoSchema.has(pool)) return;
  await pool.query(AUTO_SCHEMA_SQL);
  ensuredAutoSchema.add(pool);
}
