/**
 * AWS adapter for the Auto core.
 *
 * Implements:
 *   - AutoRunRepository       over DynamoDB (table `AutoRuns`, PK runId; audit
 *                             appended via list_append, spend via atomic ADD,
 *                             kill-switch via a boolean flag).
 *   - AutoApprovalRepository  over DynamoDB (table `AutoApprovals`, PK approvalId,
 *                             GSI userKitKey-index for getApprovalForKit, GSI
 *                             userId-index for listApprovalsByUser).
 *   - WorkspaceStore          via FsWorkspaceStore rooted at an OS tmp dir.
 *
 * WORKSPACE CHOICE (Phase A): workspaces are run-ephemeral and small, and the
 * Fargate/Job task that runs them is short-lived, so we back them with a local
 * tmp dir on the task's own filesystem (FsWorkspaceStore) rather than S3. An
 * S3-prefix-backed WorkspaceStore (durable, cross-task) is a Phase B/C concern
 * and slots in behind the same WorkspaceStore port without touching the driver.
 *
 * Explicit-creds env pattern mirrors gateway-core / forge-web: FORGE_AWS_* take
 * precedence, falling back to AWS_REGION / the default credential chain.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  AutoWebhookRepository,
  EventSourceRepository,
  FireLogRepository,
  InputStore,
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
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  AutoWebhook,
  CreateApprovalInput,
  CreateEventSourceInput,
  CreateRunInput,
  CreateScheduleInput,
  CreateTriggerInput,
  CreateWebhookInput,
  EventSource,
  KitRef,
  NetworkPolicy,
  ReceivedEvent,
  Trigger,
  TriggerFireLog,
  TriggerFireRecord,
  TriggerType,
  UpdateEventSourceInput,
  UpdateScheduleInput,
  UpdateTriggerInput,
  WebhookFireResult,
} from "../../core/types.js";
import { kitRefKey, normalizeNetworkPolicy } from "../../core/types.js";
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
import { FsWorkspaceStore } from "../../core/fs-workspace.js";
import { LocalInputStore } from "../../core/input-store.js";
import { S3InputStore } from "./s3-input-store.js";

// ---------------------------------------------------------------------------
// Client factory (FORGE_AWS_* explicit creds, like gateway-core / forge-web)
// ---------------------------------------------------------------------------

export function awsClientEnv(
  env: Record<string, string | undefined> = process.env,
): DynamoDBClientConfig {
  const region = env["FORGE_AWS_REGION"] || env["AWS_REGION"] || "us-east-1";
  const accessKeyId = env["FORGE_AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["FORGE_AWS_SECRET_ACCESS_KEY"];
  return {
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  };
}

/**
 * Same FORGE_AWS_* explicit-creds resolution as {@link awsClientEnv}, typed for
 * the S3 client (the SDK rejects a cross-client config type even though the
 * region/credentials shape is identical). Used for the Phase C inputs bucket.
 */
export function s3ClientEnv(
  env: Record<string, string | undefined> = process.env,
): S3ClientConfig {
  const region = env["FORGE_AWS_REGION"] || env["AWS_REGION"] || "us-east-1";
  const accessKeyId = env["FORGE_AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["FORGE_AWS_SECRET_ACCESS_KEY"];
  return {
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  };
}

export function createDynamoDBDocumentClient(
  config?: DynamoDBClientConfig,
): DynamoDBDocumentClient {
  const client = new DynamoDBClient(config ?? awsClientEnv());
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export interface AutoDynamoTableNames {
  runs: string;
  approvals: string;
  schedules: string;
  webhooks: string;
  /**
   * Event-driven expansion tables. OPTIONAL (deploy-safe additive rollout:
   * existing deployments/env sets keep working; when omitted the documented
   * defaults below apply — AutoTriggers / AutoEventSources / AutoReceivedEvents
   * / AutoFireLogs).
   */
  triggers?: string;
  eventSources?: string;
  receivedEvents?: string;
  fireLogs?: string;
  secrets?: string;
}

export const AUTO_TABLE_ENV_VARS = {
  runs: "AUTO_RUNS_TABLE",
  approvals: "AUTO_APPROVALS_TABLE",
  schedules: "AUTO_SCHEDULES_TABLE",
  webhooks: "AUTO_WEBHOOKS_TABLE",
  triggers: "AUTO_TRIGGERS_TABLE",
  eventSources: "AUTO_EVENT_SOURCES_TABLE",
  receivedEvents: "AUTO_RECEIVED_EVENTS_TABLE",
  fireLogs: "AUTO_FIRE_LOGS_TABLE",
  secrets: "AUTO_SECRETS_TABLE",
} as const;

/** Documented defaults for the OPTIONAL event-driven expansion tables. */
export const AUTO_EVENT_TABLE_DEFAULTS = {
  triggers: "AutoTriggers",
  eventSources: "AutoEventSources",
  receivedEvents: "AutoReceivedEvents",
  fireLogs: "AutoFireLogs",
  secrets: "AutoSecrets",
} as const;

export function loadAutoDynamoTableNames(
  env: Record<string, string | undefined> = process.env,
): AutoDynamoTableNames {
  const resolve = (key: string): string => {
    const value = env[key];
    if (!value || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  };
  // The four ORIGINAL tables stay REQUIRED (unchanged contract); the event
  // tables resolve to defaults so an un-migrated env never throws at boot.
  const optional = (key: string, fallback: string): string => {
    const value = env[key];
    return value && value.trim() !== "" ? value : fallback;
  };
  return {
    runs: resolve(AUTO_TABLE_ENV_VARS.runs),
    approvals: resolve(AUTO_TABLE_ENV_VARS.approvals),
    schedules: resolve(AUTO_TABLE_ENV_VARS.schedules),
    webhooks: resolve(AUTO_TABLE_ENV_VARS.webhooks),
    triggers: optional(AUTO_TABLE_ENV_VARS.triggers, AUTO_EVENT_TABLE_DEFAULTS.triggers),
    eventSources: optional(
      AUTO_TABLE_ENV_VARS.eventSources,
      AUTO_EVENT_TABLE_DEFAULTS.eventSources,
    ),
    receivedEvents: optional(
      AUTO_TABLE_ENV_VARS.receivedEvents,
      AUTO_EVENT_TABLE_DEFAULTS.receivedEvents,
    ),
    fireLogs: optional(AUTO_TABLE_ENV_VARS.fireLogs, AUTO_EVENT_TABLE_DEFAULTS.fireLogs),
    secrets: optional(AUTO_TABLE_ENV_VARS.secrets, AUTO_EVENT_TABLE_DEFAULTS.secrets),
  };
}

// ---------------------------------------------------------------------------
// DynamoDB AutoRunRepository
// ---------------------------------------------------------------------------

export class DynamoAutoRunRepository implements AutoRunRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createRun(input: CreateRunInput): Promise<AutoRun> {
    const run: AutoRun = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      status: "queued",
      input: input.input,
      budgetCents: input.budgetCents,
      spentCents: 0,
      spentInferenceCents: 0,
      spentComputeCents: 0,
      inferenceMode: input.inferenceMode ?? "managed",
      ...(input.isCloudRun !== undefined ? { isCloudRun: input.isCloudRun } : {}),
      ...(input.cloudRunCentsPerMin !== undefined
        ? { cloudRunCentsPerMin: input.cloudRunCentsPerMin }
        : {}),
      model: input.model,
      createdAt: input.createdAt,
      auditLog: [],
      cancelRequested: false,
      trigger: input.trigger ?? "on_demand",
      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
      ...(input.webhookId !== undefined ? { webhookId: input.webhookId } : {}),
      ...(input.triggerId !== undefined ? { triggerId: input.triggerId } : {}),
      ...(input.inputFiles !== undefined ? { inputFiles: input.inputFiles } : {}),
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        // GSI partition for listRunsByUser.
        Item: { ...run, gsiUserId: input.userId },
      }),
    );
    return run;
  }

  async getRun(runId: string): Promise<AutoRun | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: runId } }),
    );
    return result.Item ? stripGsi(result.Item) : undefined;
  }

  async listRunsByUser(userId: string, limit = 50): Promise<AutoRun[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((i) => stripGsi(i));
  }

  /** L4 concurrency-cap read: ACTIVE (queued/running) runs for the user.
   *  Server-side COUNT over the user GSI with a status filter; pages through
   *  LastEvaluatedKey so the count stays exact for large histories. */
  async countActiveRuns(userId: string): Promise<number> {
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "userId-index",
          KeyConditionExpression: "gsiUserId = :u",
          FilterExpression: "#s IN (:queued, :running)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":u": userId, ":queued": "queued", ":running": "running" },
          Select: "COUNT",
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      count += result.Count ?? 0;
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return count;
  }

  async updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields: { startedAt?: string; finishedAt?: string; error?: string; workspaceId?: string } = {},
  ): Promise<AutoRun | undefined> {
    const sets: string[] = ["#s = :s"];
    const names: Record<string, string> = { "#s": "status" };
    const values: Record<string, unknown> = { ":s": status };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = :${k}`);
      values[`:${k}`] = v;
    }
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes ? stripGsi(result.Attributes) : undefined;
  }

  async appendAudit(runId: string, entry: AuditEntry): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression:
          "SET auditLog = list_append(if_not_exists(auditLog, :empty), :e)",
        ExpressionAttributeValues: { ":empty": [] as AuditEntry[], ":e": [entry] },
      }),
    );
  }

  async setResult(runId: string, result: AutoRunResult): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: "SET #r = :r",
        ExpressionAttributeNames: { "#r": "result" },
        ExpressionAttributeValues: { ":r": result },
      }),
    );
  }

  async recordSpend(runId: string, deltaCents: number): Promise<number> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: "ADD spentCents :d",
        ExpressionAttributeValues: { ":d": deltaCents },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (result.Attributes?.["spentCents"] as number) ?? deltaCents;
  }

  async requestCancel(runId: string): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: runId },
        UpdateExpression: "SET cancelRequested = :t",
        ExpressionAttributeValues: { ":t": true },
      }),
    );
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    return run?.cancelRequested === true;
  }
}

function stripGsi(item: Record<string, unknown>): AutoRun {
  const { gsiUserId: _gsiUserId, ...rest } = item as Record<string, unknown> & {
    gsiUserId?: string;
  };
  return rest as unknown as AutoRun;
}

// ---------------------------------------------------------------------------
// DynamoDB AutoApprovalRepository
// ---------------------------------------------------------------------------

export class DynamoAutoApprovalRepository implements AutoApprovalRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createApproval(input: CreateApprovalInput): Promise<AutoApproval> {
    const approval: AutoApproval = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      scope: input.scope ?? "workspace_read_write",
      toolAllowlist: input.toolAllowlist,
      networkPolicy: normalizeNetworkPolicy(input.networkPolicy),
      maxBudgetCents: input.maxBudgetCents,
      createdAt: input.createdAt,
      revokedAt: null,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...approval,
          gsiUserId: input.userId,
          gsiUserKitKey: `${input.userId}#${kitRefKey(input.kitRef)}`,
        },
      }),
    );
    return approval;
  }

  async getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userKitKey-index",
        KeyConditionExpression: "gsiUserKitKey = :k",
        ExpressionAttributeValues: { ":k": `${userId}#${kitRefKey(kitRef)}` },
      }),
    );
    const items = (result.Items ?? []).map(stripApprovalGsi);
    return items.find((a) => a.revokedAt === null);
  }

  async listApprovalsByUser(userId: string): Promise<AutoApproval[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripApprovalGsi);
  }

  async revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: approvalId },
        UpdateExpression: "SET revokedAt = :r",
        ExpressionAttributeValues: { ":r": revokedAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes ? stripApprovalGsi(result.Attributes) : undefined;
  }
}

function stripApprovalGsi(item: Record<string, unknown>): AutoApproval {
  const { gsiUserId: _u, gsiUserKitKey: _k, ...rest } = item as Record<string, unknown> & {
    gsiUserId?: string;
    gsiUserKitKey?: string;
  };
  // Normalize legacy/persisted networkPolicy (a bare "deny_all" string from
  // pre-Phase-C rows) into the Phase C object shape.
  (rest as { networkPolicy?: NetworkPolicy }).networkPolicy = normalizeNetworkPolicy(
    (rest as { networkPolicy?: unknown }).networkPolicy,
  );
  return rest as unknown as AutoApproval;
}

// ---------------------------------------------------------------------------
// DynamoDB AutoScheduleRepository (Phase B)
// ---------------------------------------------------------------------------

/**
 * Table `AutoSchedules`, PK `id`.
 *   - GSI `userId-index`  (PK gsiUserId)        — listSchedulesByUser.
 *   - GSI `dueIndex`      (PK gsiDue, SK nextRunAt)
 *       gsiDue is a CONSTANT partition ("1") for every ENABLED schedule, and is
 *       REMOVED when a schedule is disabled. listDueSchedules then becomes a
 *       single Query on gsiDue="1" with KeyCondition nextRunAt <= now — only the
 *       enabled, actually-due rows are read (no table scan).
 *
 *       Tradeoff: a single hot partition for due-selection. At Phase B scale
 *       (cron schedules per user, swept once/minute) this is well within a
 *       partition's throughput; if it ever became hot we'd shard gsiDue by a
 *       bucket prefix and fan the sweep across buckets. Documented here so the
 *       CDK stack (agentkitauto-infra) mirrors the key schema.
 */
const DUE_PARTITION = "1";

function scheduleGsiFields(s: AutoSchedule): Record<string, unknown> {
  return {
    gsiUserId: s.userId,
    // Only enabled schedules participate in the due index.
    ...(s.enabled ? { gsiDue: DUE_PARTITION } : {}),
  };
}

export class DynamoAutoScheduleRepository implements AutoScheduleRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createSchedule(input: CreateScheduleInput): Promise<AutoSchedule> {
    const schedule: AutoSchedule = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      input: input.input,
      budgetCents: input.budgetCents,
      model: input.model,
      approvalId: input.approvalId,
      ...(input.inferenceMode !== undefined ? { inferenceMode: input.inferenceMode } : {}),
      enabled: input.enabled ?? true,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      lastRunAt: null,
      lastRunId: null,
      nextRunAt: input.nextRunAt,
      lastError: null,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...schedule, ...scheduleGsiFields(schedule) },
      }),
    );
    return schedule;
  }

  async getSchedule(scheduleId: string): Promise<AutoSchedule | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: scheduleId } }),
    );
    return result.Item ? stripScheduleGsi(result.Item) : undefined;
  }

  async listSchedulesByUser(userId: string): Promise<AutoSchedule[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripScheduleGsi);
  }

  async listDueSchedules(nowISO: string): Promise<AutoSchedule[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "dueIndex",
        KeyConditionExpression: "gsiDue = :p AND nextRunAt <= :now",
        ExpressionAttributeValues: { ":p": DUE_PARTITION, ":now": nowISO },
      }),
    );
    return (result.Items ?? []).map(stripScheduleGsi);
  }

  async updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined> {
    // Read-modify-write: the due-index participation (gsiDue presence) depends on
    // the post-patch `enabled`, which is simplest to recompute from the merged
    // record and re-Put. Schedule edits are low-frequency.
    const current = await this.getSchedule(scheduleId);
    if (!current) return undefined;
    const next: AutoSchedule = {
      ...current,
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.input !== undefined ? { input: patch.input } : {}),
      ...(patch.budgetCents !== undefined ? { budgetCents: patch.budgetCents } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.approvalId !== undefined ? { approvalId: patch.approvalId } : {}),
      ...(patch.inferenceMode !== undefined ? { inferenceMode: patch.inferenceMode } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      updatedAt: patch.updatedAt,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...next, ...scheduleGsiFields(next) },
      }),
    );
    return next;
  }

  async setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: scheduleId },
        UpdateExpression:
          "SET lastRunAt = :lra, lastRunId = :lri, nextRunAt = :nra, lastError = :le",
        ExpressionAttributeValues: {
          ":lra": result.lastRunAt,
          ":lri": result.lastRunId,
          ":nra": result.nextRunAt,
          ":le": result.lastError,
        },
      }),
    );
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id: scheduleId } }),
    );
  }
}

function stripScheduleGsi(item: Record<string, unknown>): AutoSchedule {
  const { gsiUserId: _u, gsiDue: _d, ...rest } = item as Record<string, unknown> & {
    gsiUserId?: string;
    gsiDue?: string;
  };
  return rest as unknown as AutoSchedule;
}

// ---------------------------------------------------------------------------
// DynamoDB AutoWebhookRepository (Phase C)
// ---------------------------------------------------------------------------

/**
 * Table `AutoWebhooks`, PK `id`.
 *   - GSI `userId-index` (PK gsiUserId) — listWebhooksByUser.
 * Stores ONLY the secret HASH (never the plaintext). fireCount is incremented
 * atomically via an ADD on recordFire.
 */
export class DynamoAutoWebhookRepository implements AutoWebhookRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async createWebhook(input: CreateWebhookInput): Promise<AutoWebhook> {
    const webhook: AutoWebhook = {
      id: randomUUID(),
      userId: input.userId,
      kitRef: input.kitRef,
      approvalId: input.approvalId,
      budgetCents: input.budgetCents,
      model: input.model,
      ...(input.inferenceMode !== undefined ? { inferenceMode: input.inferenceMode } : {}),
      enabled: input.enabled ?? true,
      secretHash: input.secretHash,
      createdAt: input.createdAt,
      lastFiredAt: null,
      lastRunId: null,
      lastError: null,
      fireCount: 0,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...webhook, gsiUserId: input.userId },
      }),
    );
    return webhook;
  }

  async getWebhook(webhookId: string): Promise<AutoWebhook | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: webhookId } }),
    );
    return result.Item ? stripWebhookGsi(result.Item) : undefined;
  }

  async listWebhooksByUser(userId: string): Promise<AutoWebhook[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripWebhookGsi);
  }

  async recordFire(webhookId: string, result: WebhookFireResult): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: webhookId },
        UpdateExpression:
          "SET lastFiredAt = :lfa, lastRunId = :lri, lastError = :le ADD fireCount :one",
        ExpressionAttributeValues: {
          ":lfa": result.lastFiredAt,
          ":lri": result.lastRunId,
          ":le": result.lastError,
          ":one": 1,
        },
      }),
    );
  }

  async setEnabled(webhookId: string, enabled: boolean): Promise<AutoWebhook | undefined> {
    const result = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: webhookId },
        UpdateExpression: "SET enabled = :e",
        ExpressionAttributeValues: { ":e": enabled },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes ? stripWebhookGsi(result.Attributes) : undefined;
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id: webhookId } }),
    );
  }
}

function stripWebhookGsi(item: Record<string, unknown>): AutoWebhook {
  const { gsiUserId: _u, ...rest } = item as Record<string, unknown> & { gsiUserId?: string };
  const w = rest as unknown as AutoWebhook;
  // Dynamo ADD on a missing attribute starts at the delta; defend fireCount.
  w.fireCount = Number(w.fireCount ?? 0);
  return w;
}

// ---------------------------------------------------------------------------
// DynamoDB TriggerRepository (event-driven expansion)
// ---------------------------------------------------------------------------

/**
 * Table `AutoTriggers`, PK `id`.
 *   - GSI `userId-index` (PK gsiUserId) — listTriggersByUser.
 *   - GSI `dueIndex`     (PK gsiDueType, SK gsiDueCursor)
 *       gsiDueType = the trigger TYPE, present ONLY while the trigger is
 *       enabled AND not circuit-paused (disabled/paused rows leave the index —
 *       the same participation trick as AutoSchedules' gsiDue). gsiDueCursor =
 *       the poll/schedule cursor, with a NULL cursor stored as "0" so a
 *       never-initialized schedule sorts before any ISO timestamp (always due).
 *       listDue("schedule", now) = Query gsiDueType="schedule" AND
 *       gsiDueCursor <= now; polled types query the partition without an SK
 *       condition (every enabled trigger of the type is due each sweep).
 *
 * Mutations are read-modify-write Puts (the due-index participation depends on
 * the post-write enabled/paused/cursor state; trigger writes are low-frequency,
 * exactly like AutoSchedules.updateSchedule).
 */
const NULL_CURSOR_SORT_KEY = "0";

function triggerGsiFields(t: Trigger): Record<string, unknown> {
  const paused = t.circuit.pausedAt !== null && t.circuit.pausedAt !== undefined;
  return {
    gsiUserId: t.userId,
    ...(t.enabled && !paused
      ? { gsiDueType: t.type, gsiDueCursor: t.cursor ?? NULL_CURSOR_SORT_KEY }
      : {}),
  };
}

function stripTriggerGsi(item: Record<string, unknown>): Trigger {
  const {
    gsiUserId: _u,
    gsiDueType: _t,
    gsiDueCursor: _c,
    ...rest
  } = item as Record<string, unknown> & {
    gsiUserId?: string;
    gsiDueType?: string;
    gsiDueCursor?: string;
  };
  const t = rest as unknown as Trigger;
  t.fireCount = Number(t.fireCount ?? 0);
  return t;
}

export class DynamoTriggerRepository implements TriggerRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async put(trigger: Trigger): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...trigger, ...triggerGsiFields(trigger) },
      }),
    );
  }

  async createTrigger(input: CreateTriggerInput): Promise<Trigger> {
    const trigger = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      type: input.type,
      config: input.config,
      kitRef: input.kitRef,
      approvalId: input.approvalId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.budgetCents !== undefined ? { budgetCents: input.budgetCents } : {}),
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
      mapping: input.mapping,
      ...(input.destinations !== undefined ? { destinations: input.destinations } : {}),
      rateLimit: input.rateLimit ?? { maxPerHour: 20 },
      enabled: input.enabled ?? true,
      cursor: null,
      circuit: { consecutiveFailures: 0, pausedAt: null },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      fireCount: 0,
    } as Trigger;
    await this.put(trigger);
    return trigger;
  }

  async getTrigger(triggerId: string): Promise<Trigger | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: triggerId } }),
    );
    return result.Item ? stripTriggerGsi(result.Item) : undefined;
  }

  async listTriggersByUser(userId: string): Promise<Trigger[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripTriggerGsi);
  }

  async listDue(type: TriggerType, nowISO: string): Promise<Trigger[]> {
    const scheduleDue = type === "schedule";
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "dueIndex",
        KeyConditionExpression: scheduleDue
          ? "gsiDueType = :t AND gsiDueCursor <= :now"
          : "gsiDueType = :t",
        ExpressionAttributeValues: {
          ":t": type,
          ...(scheduleDue ? { ":now": nowISO } : {}),
        },
      }),
    );
    return (result.Items ?? []).map(stripTriggerGsi);
  }

  async updateTrigger(
    triggerId: string,
    patch: UpdateTriggerInput,
  ): Promise<Trigger | undefined> {
    const current = await this.getTrigger(triggerId);
    if (!current) return undefined;
    // `type` is immutable and `circuit` is ONLY written by the circuit ops.
    const next = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.approvalId !== undefined ? { approvalId: patch.approvalId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.budgetCents !== undefined ? { budgetCents: patch.budgetCents } : {}),
      ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
      ...(patch.mapping !== undefined ? { mapping: patch.mapping } : {}),
      ...(patch.destinations !== undefined ? { destinations: patch.destinations } : {}),
      ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      updatedAt: patch.updatedAt,
    } as Trigger;
    await this.put(next);
    return next;
  }

  async recordFire(triggerId: string, result: TriggerFireRecord): Promise<void> {
    const current = await this.getTrigger(triggerId);
    if (!current) return;
    const next = {
      ...current,
      lastFiredAt: result.lastFiredAt,
      ...(result.lastRunId !== null ? { lastRunId: result.lastRunId } : {}),
      fireCount: current.fireCount + 1,
    } as Trigger;
    if (result.lastError !== null) next.lastError = result.lastError;
    else delete (next as { lastError?: string }).lastError;
    await this.put(next);
  }

  async updateCursor(triggerId: string, cursor: string | null): Promise<void> {
    const current = await this.getTrigger(triggerId);
    if (!current) return;
    await this.put({ ...current, cursor } as Trigger);
  }

  async recordCircuitFailure(triggerId: string): Promise<number> {
    const current = await this.getTrigger(triggerId);
    if (!current) return 0;
    const failures = current.circuit.consecutiveFailures + 1;
    await this.put({
      ...current,
      circuit: { ...current.circuit, consecutiveFailures: failures },
    } as Trigger);
    return failures;
  }

  async resetCircuit(triggerId: string): Promise<void> {
    const current = await this.getTrigger(triggerId);
    if (!current) return;
    await this.put({
      ...current,
      circuit: { consecutiveFailures: 0, pausedAt: null },
    } as Trigger);
  }

  async setCircuitPaused(triggerId: string, pausedAt: string | null): Promise<void> {
    const current = await this.getTrigger(triggerId);
    if (!current) return;
    await this.put({ ...current, circuit: { ...current.circuit, pausedAt } } as Trigger);
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id: triggerId } }),
    );
  }
}

// ---------------------------------------------------------------------------
// DynamoDB EventSourceRepository (event-driven expansion)
// ---------------------------------------------------------------------------

/**
 * Table `AutoEventSources`, PK `id`.
 *   - GSI `userId-index`    (PK gsiUserId)    — listEventSourcesByUser.
 *   - GSI `tokenHash-index` (PK gsiTokenHash) — findByTokenHash (ingest auth
 *     lookup — hashes only; the plaintext token is NEVER persisted, S2).
 */
function stripEventSourceGsi(item: Record<string, unknown>): EventSource {
  // signingSecretRef is INTERNAL (S2): stripped from every domain read; the
  // ingest route reads it via getSigningSecretRef only.
  const {
    gsiUserId: _u,
    gsiTokenHash: _t,
    signingSecretRef: _ref,
    ...rest
  } = item as Record<string, unknown> & {
    gsiUserId?: string;
    gsiTokenHash?: string;
    signingSecretRef?: string | null;
  };
  const s = rest as unknown as EventSource;
  s.eventCount = Number(s.eventCount ?? 0);
  return s;
}

export class DynamoEventSourceRepository implements EventSourceRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async put(source: EventSource, signingSecretRef: string | null): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...source,
          ...(signingSecretRef !== null ? { signingSecretRef } : {}),
          gsiUserId: source.userId,
          gsiTokenHash: source.tokenHash,
        },
      }),
    );
  }

  /** Raw item read (keeps the internal signingSecretRef attribute). */
  private async getItem(sourceId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: sourceId } }),
    );
    return result.Item as Record<string, unknown> | undefined;
  }

  async createEventSource(input: CreateEventSourceInput): Promise<EventSource> {
    const signingSecretRef = input.signingSecretRef ?? null;
    const source: EventSource = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      kind: input.kind,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      tokenHash: input.tokenHash,
      hasSigningSecret: signingSecretRef !== null ? true : input.hasSigningSecret,
      enabled: input.enabled ?? true,
      createdAt: input.createdAt,
      eventCount: 0,
    };
    await this.put(source, signingSecretRef);
    return source;
  }

  async getEventSource(sourceId: string): Promise<EventSource | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: sourceId } }),
    );
    return result.Item ? stripEventSourceGsi(result.Item) : undefined;
  }

  async listEventSourcesByUser(userId: string): Promise<EventSource[]> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "userId-index",
        KeyConditionExpression: "gsiUserId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (result.Items ?? []).map(stripEventSourceGsi);
  }

  async findByTokenHash(tokenHash: string): Promise<EventSource | undefined> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "tokenHash-index",
        KeyConditionExpression: "gsiTokenHash = :h",
        ExpressionAttributeValues: { ":h": tokenHash },
      }),
    );
    const item = (result.Items ?? [])[0];
    return item ? stripEventSourceGsi(item) : undefined;
  }

  async updateEventSource(
    sourceId: string,
    patch: UpdateEventSourceInput,
  ): Promise<EventSource | undefined> {
    // Read-modify-write Put so a tokenHash rotation also updates gsiTokenHash
    // (and a signingSecretRef change keeps the internal attribute + the
    // derived hasSigningSecret coherent).
    const item = await this.getItem(sourceId);
    if (!item) return undefined;
    const current = stripEventSourceGsi({ ...item });
    const currentRef = (item["signingSecretRef"] as string | undefined) ?? null;
    const nextRef =
      patch.signingSecretRef !== undefined ? patch.signingSecretRef : currentRef;
    const next: EventSource = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.tokenHash !== undefined ? { tokenHash: patch.tokenHash } : {}),
      ...(patch.signingSecretRef !== undefined
        ? { hasSigningSecret: patch.signingSecretRef !== null }
        : {}),
    };
    await this.put(next, nextRef);
    return next;
  }

  async getSigningSecretRef(sourceId: string): Promise<string | undefined> {
    const item = await this.getItem(sourceId);
    const ref = item?.["signingSecretRef"];
    return typeof ref === "string" && ref.length > 0 ? ref : undefined;
  }

  async recordEvent(sourceId: string, receivedAt: string): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: sourceId },
        UpdateExpression: "SET lastEventAt = :lea ADD eventCount :one",
        ExpressionAttributeValues: { ":lea": receivedAt, ":one": 1 },
      }),
    );
  }

  async deleteEventSource(sourceId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id: sourceId } }),
    );
  }
}

// ---------------------------------------------------------------------------
// DynamoDB ReceivedEventRepository (inspector ring buffer)
// ---------------------------------------------------------------------------

/**
 * Table `AutoReceivedEvents`, PK `id`.
 *   - GSI `sourceId-index` (PK gsiSourceId, SK receivedAt) — newest-first
 *     listing + the ring-buffer prune walk.
 *   - `ttl` (epoch seconds, receivedAt + RECEIVED_EVENT_TTL_MS) — native
 *     DynamoDB table TTL expires old rows even without appends.
 * Ring-buffer semantics: appendEvent prunes rows beyond the per-source cap.
 * Payloads are stored JSON-STRINGIFIED (`payloadJson`) so any JSON value —
 * including bare strings/numbers — round-trips through the document client.
 */
function itemToReceivedEvent(item: Record<string, unknown>): ReceivedEvent {
  const payloadJson = item["payloadJson"] as string | undefined;
  return {
    id: item["id"] as string,
    sourceId: item["sourceId"] as string,
    name: item["name"] as string,
    receivedAt: item["receivedAt"] as string,
    payload: payloadJson === undefined ? undefined : (JSON.parse(payloadJson) as unknown),
  };
}

export class DynamoReceivedEventRepository implements ReceivedEventRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly capPerSource = RECEIVED_EVENTS_PER_SOURCE_CAP,
    private readonly ttlMs = RECEIVED_EVENT_TTL_MS,
  ) {}

  async appendEvent(input: AppendReceivedEventInput): Promise<ReceivedEvent> {
    const event: ReceivedEvent = {
      id: randomUUID(),
      sourceId: input.sourceId,
      name: input.name,
      receivedAt: input.receivedAt,
      payload: input.payload,
    };
    const receivedMs = Date.parse(input.receivedAt);
    const ttlSeconds = Number.isFinite(receivedMs)
      ? Math.floor((receivedMs + this.ttlMs) / 1000)
      : undefined;
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          id: event.id,
          sourceId: event.sourceId,
          name: event.name,
          receivedAt: event.receivedAt,
          ...(input.payload !== undefined
            ? { payloadJson: JSON.stringify(input.payload) }
            : {}),
          gsiSourceId: event.sourceId,
          ...(ttlSeconds !== undefined ? { ttl: ttlSeconds } : {}),
        },
      }),
    );
    await this.pruneEvents(input.sourceId);
    return event;
  }

  private async querySourceNewestFirst(
    sourceId: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "sourceId-index",
          KeyConditionExpression: "gsiSourceId = :s",
          ExpressionAttributeValues: { ":s": sourceId },
          ScanIndexForward: false,
          ...(limit !== undefined ? { Limit: limit - items.length } : {}),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (limit !== undefined && items.length >= limit) break;
    } while (lastKey);
    return items;
  }

  async listEventsBySource(sourceId: string, limit = 50): Promise<ReceivedEvent[]> {
    const items = await this.querySourceNewestFirst(sourceId, limit);
    return items.slice(0, limit).map(itemToReceivedEvent);
  }

  async getEvent(eventId: string): Promise<ReceivedEvent | undefined> {
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { id: eventId } }),
    );
    return result.Item ? itemToReceivedEvent(result.Item) : undefined;
  }

  async pruneEvents(sourceId: string): Promise<number> {
    const items = await this.querySourceNewestFirst(sourceId);
    const newest = items[0]?.["receivedAt"] as string | undefined;
    const ttlCutoffMs = newest !== undefined ? Date.parse(newest) - this.ttlMs : undefined;
    let removed = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const receivedMs = Date.parse(item["receivedAt"] as string);
      const pastTtl =
        ttlCutoffMs !== undefined && Number.isFinite(receivedMs) && receivedMs < ttlCutoffMs;
      if (i >= this.capPerSource || pastTtl) {
        await this.db.send(
          new DeleteCommand({ TableName: this.tableName, Key: { id: item["id"] } }),
        );
        removed += 1;
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// DynamoDB FireLogRepository (abuse/cost observability)
// ---------------------------------------------------------------------------

/**
 * Table `AutoFireLogs`, PK `id`.
 *   - GSI `triggerId-index` (PK gsiTriggerId, SK at) — newest-first listing +
 *     the ring-buffer prune walk (cap FIRE_LOGS_PER_TRIGGER_CAP per trigger).
 */
function itemToFireLog(item: Record<string, unknown>): TriggerFireLog {
  return {
    id: item["id"] as string,
    triggerId: item["triggerId"] as string,
    at: item["at"] as string,
    outcome: item["outcome"] as TriggerFireLog["outcome"],
    runId: (item["runId"] as string | null | undefined) ?? null,
    detail: (item["detail"] as string | null | undefined) ?? null,
  };
}

export class DynamoFireLogRepository implements FireLogRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly capPerTrigger = FIRE_LOGS_PER_TRIGGER_CAP,
  ) {}

  private async queryTriggerNewestFirst(
    triggerId: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "triggerId-index",
          KeyConditionExpression: "gsiTriggerId = :t",
          ExpressionAttributeValues: { ":t": triggerId },
          ScanIndexForward: false,
          ...(limit !== undefined ? { Limit: limit - items.length } : {}),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (limit !== undefined && items.length >= limit) break;
    } while (lastKey);
    return items;
  }

  async appendFireLog(input: AppendFireLogInput): Promise<TriggerFireLog> {
    const log: TriggerFireLog = {
      id: randomUUID(),
      triggerId: input.triggerId,
      at: input.at,
      outcome: input.outcome,
      runId: input.runId ?? null,
      detail: input.detail ?? null,
    };
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...log, gsiTriggerId: input.triggerId },
      }),
    );
    // Ring-buffer semantics: evict beyond the per-trigger cap.
    const items = await this.queryTriggerNewestFirst(input.triggerId);
    for (const item of items.slice(this.capPerTrigger)) {
      await this.db.send(
        new DeleteCommand({ TableName: this.tableName, Key: { id: item["id"] } }),
      );
    }
    return log;
  }

  async listFireLogsByTrigger(triggerId: string, limit = 100): Promise<TriggerFireLog[]> {
    const items = await this.queryTriggerNewestFirst(triggerId, limit);
    return items.slice(0, limit).map(itemToFireLog);
  }
}

// ---------------------------------------------------------------------------
// DynamoDB SecretStore (encrypted-at-rest provider signing secrets — S2)
// ---------------------------------------------------------------------------

/**
 * Table `AutoSecrets`, PK `secretRef`. AES-256-GCM with the operator key from
 * AUTO_SECRET_ENCRYPTION_KEY, loaded LAZILY per call — an unconfigured
 * deployment only fails (typed SecretStoreUnconfiguredError) when secret
 * storage is actually used.
 */
export class DynamoSecretStore implements SecretStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async put(plaintext: string): Promise<string> {
    const key = loadSecretEncryptionKey(this.env);
    const secretRef = randomUUID();
    const enc = encryptSecret(key, plaintext);
    await this.db.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          secretRef,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          tag: enc.tag,
          createdAt: new Date().toISOString(),
        },
      }),
    );
    return secretRef;
  }

  async reveal(secretRef: string): Promise<string> {
    const key = loadSecretEncryptionKey(this.env);
    const result = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { secretRef } }),
    );
    if (!result.Item) throw new Error(`Unknown secretRef: ${secretRef}`);
    return decryptSecret(key, {
      ciphertext: result.Item["ciphertext"] as string,
      iv: result.Item["iv"] as string,
      tag: result.Item["tag"] as string,
    });
  }

  async delete(secretRef: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { secretRef } }),
    );
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface MakeAwsAutoDepsOptions {
  tables?: AutoDynamoTableNames;
  db?: DynamoDBDocumentClient;
  /** Workspace root; defaults to an OS tmp dir. */
  workspaceRootDir?: string;
  /**
   * S3 bucket for Phase C staged input files (`auto-inputs/{runId}/...`). When
   * set, an S3InputStore is used; otherwise a LocalInputStore (suitable for dev
   * / tests). Defaults to AUTO_INPUTS_BUCKET when unset.
   */
  inputsBucket?: string;
  /** Optional S3 client (defaults to one built from awsClientEnv). */
  s3Client?: S3Client;
}

/** Builds the AWS-backed storage deps. */
export function makeAwsAutoDeps(options: MakeAwsAutoDepsOptions = {}): AutoStorageDeps {
  const tables = options.tables ?? loadAutoDynamoTableNames();
  const db = options.db ?? createDynamoDBDocumentClient();
  const rootDir = options.workspaceRootDir ?? nodePath.join(os.tmpdir(), "agentkitauto-workspaces");
  const inputsBucket = options.inputsBucket ?? process.env["AUTO_INPUTS_BUCKET"];
  const inputs: InputStore = inputsBucket
    ? new S3InputStore({
        client: options.s3Client ?? new S3Client(s3ClientEnv()),
        bucket: inputsBucket,
      })
    : new LocalInputStore();
  return {
    runs: new DynamoAutoRunRepository(db, tables.runs),
    approvals: new DynamoAutoApprovalRepository(db, tables.approvals),
    schedules: new DynamoAutoScheduleRepository(db, tables.schedules),
    webhooks: new DynamoAutoWebhookRepository(db, tables.webhooks),
    workspaces: new FsWorkspaceStore({ rootDir }),
    inputs,
    // Event-driven expansion stores (always populated; table names default to
    // the documented AutoTriggers/AutoEventSources/... when not configured).
    events: {
      triggers: new DynamoTriggerRepository(
        db,
        tables.triggers ?? AUTO_EVENT_TABLE_DEFAULTS.triggers,
      ),
      eventSources: new DynamoEventSourceRepository(
        db,
        tables.eventSources ?? AUTO_EVENT_TABLE_DEFAULTS.eventSources,
      ),
      receivedEvents: new DynamoReceivedEventRepository(
        db,
        tables.receivedEvents ?? AUTO_EVENT_TABLE_DEFAULTS.receivedEvents,
      ),
      fireLogs: new DynamoFireLogRepository(
        db,
        tables.fireLogs ?? AUTO_EVENT_TABLE_DEFAULTS.fireLogs,
      ),
      secrets: new DynamoSecretStore(
        db,
        tables.secrets ?? AUTO_EVENT_TABLE_DEFAULTS.secrets,
      ),
    },
  };
}
