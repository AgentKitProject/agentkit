/**
 * In-memory test fakes for the Auto core ports + a deterministic fake
 * ChatProvider, so driver/executor tests run offline with no real model.
 */

import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  CreditLedgerRepository,
  StreamEvent,
} from "@agentkitforge/gateway-core";
import type {
  AutoRunRepository,
  ConnectionRepository,
  EventSourceRepository,
  FireLogRepository,
  OutputStore,
  ReceivedEventRepository,
  SecretStore,
  TriggerRepository,
  WorkspaceStore,
} from "../src/core/ports.js";
import type {
  AppendFireLogInput,
  AppendReceivedEventInput,
  AuditEntry,
  AutoRun,
  AutoRunOutputFile,
  AutoRunResult,
  AutoRunStatus,
  CanStartRunReason,
  CanStartRunRequest,
  Connection,
  ConnectionOwnerType,
  ConnectionStatus,
  CreateConnectionInput,
  CreateEventSourceInput,
  CreateRunInput,
  CreateTriggerInput,
  EventSource,
  ReceivedEvent,
  Trigger,
  TriggerFireLog,
  TriggerFireRecord,
  TriggerType,
  UpdateConnectionInput,
  UpdateEventSourceInput,
  UpdateTriggerInput,
  WorkspaceFileEntry,
} from "../src/core/types.js";
import type { CanStartRun } from "../src/core/trigger-runner.js";

let runSeq = 0;

export class InMemoryRunRepo implements AutoRunRepository {
  runs = new Map<string, AutoRun>();

  seed(run: AutoRun): AutoRun {
    this.runs.set(run.id, run);
    return run;
  }

  async createRun(input: CreateRunInput): Promise<AutoRun> {
    const run: AutoRun = {
      id: `run-${++runSeq}`,
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
      ...(input.deliveryConfig !== undefined ? { deliveryConfig: input.deliveryConfig } : {}),
      auditLog: [],
      cancelRequested: false,
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }

  async getRun(runId: string): Promise<AutoRun | undefined> {
    const r = this.runs.get(runId);
    return r ? structuredClone(r) : undefined;
  }

  async listRunsByUser(userId: string, limit = 50): Promise<AutoRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.userId === userId)
      .slice(0, limit)
      .map((r) => structuredClone(r));
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
    const r = this.runs.get(runId);
    if (!r) return undefined;
    r.status = status;
    if (fields.startedAt) r.startedAt = fields.startedAt;
    if (fields.finishedAt) r.finishedAt = fields.finishedAt;
    if (fields.error) r.error = fields.error;
    if (fields.workspaceId) r.workspaceId = fields.workspaceId;
    if (fields.spentInferenceCents !== undefined) r.spentInferenceCents = fields.spentInferenceCents;
    if (fields.spentComputeCents !== undefined) r.spentComputeCents = fields.spentComputeCents;
    return structuredClone(r);
  }

  async appendAudit(runId: string, entry: AuditEntry): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.auditLog.push(entry);
  }

  async setOutputFiles(runId: string, files: AutoRunOutputFile[]): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.outputFiles = structuredClone(files);
  }

  async setResult(runId: string, result: AutoRunResult): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.result = result;
  }

  async recordSpend(runId: string, deltaCents: number): Promise<number> {
    const r = this.runs.get(runId);
    if (!r) return deltaCents;
    r.spentCents += deltaCents;
    return r.spentCents;
  }

  async requestCancel(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.cancelRequested = true;
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    return this.runs.get(runId)?.cancelRequested === true;
  }
}

/** A minimal in-memory workspace for executor tests (path confinement is tested
 *  separately against the real FsWorkspaceStore). */
export class InMemoryWorkspace implements WorkspaceStore {
  files = new Map<string, Map<string, string>>();

  async createWorkspace(runId: string): Promise<string> {
    const id = `ws-${runId}`;
    this.files.set(id, new Map());
    return id;
  }
  private ws(id: string): Map<string, string> {
    const m = this.files.get(id);
    if (!m) throw new Error(`workspace not found: ${id}`);
    return m;
  }
  async readFile(workspaceId: string, path: string): Promise<string> {
    const v = this.ws(workspaceId).get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async listDir(workspaceId: string): Promise<string[]> {
    return [...this.ws(workspaceId).keys()];
  }
  async writeFile(workspaceId: string, path: string, content: string): Promise<void> {
    this.ws(workspaceId).set(path, content);
  }
  async bundleResult(workspaceId: string): Promise<WorkspaceFileEntry[]> {
    return [...this.ws(workspaceId).entries()].map(([path, content]) => ({
      path,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    }));
  }
  async cleanup(workspaceId: string): Promise<void> {
    this.files.delete(workspaceId);
  }
}

/**
 * Scripted fake ChatProvider: returns the next queued ChatResponse on each
 * sendMessage call. Deterministic + offline.
 */
export class FakeChatProvider implements ChatProvider {
  readonly providerType = "fake";
  private queue: ChatResponse[];
  calls = 0;

  constructor(responses: ChatResponse[]) {
    this.queue = [...responses];
  }

  async sendMessage(_request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    const next = this.queue.shift();
    if (!next) throw new Error("FakeChatProvider: no more scripted responses");
    return next;
  }

  async streamMessage(
    request: ChatRequest,
    _onEvent: (event: StreamEvent) => void,
  ): Promise<ChatResponse> {
    return this.sendMessage(request);
  }
}

/** Build a ChatResponse with text + optional tool_use blocks. */
export function textResponse(text: string, outputTokens = 100): ChatResponse {
  return {
    content: [{ type: "text", text }] as ContentBlock[],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0 },
  };
}

export function toolUseResponse(
  toolName: string,
  input: Record<string, unknown>,
  id = "tu-1",
  outputTokens = 100,
): ChatResponse {
  return {
    content: [{ type: "tool_use", id, name: toolName, input }] as ContentBlock[],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0 },
  };
}

export const noopNow = (): string => "2026-06-18T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Event-driven expansion fakes (trigger/event-source/received-event/fire-log)
// ---------------------------------------------------------------------------

let triggerSeq = 0;
let receivedEventSeq = 0;
let fireLogSeq = 0;

export class InMemoryTriggerRepo implements TriggerRepository {
  triggers = new Map<string, Trigger>();

  seed(trigger: Trigger): Trigger {
    this.triggers.set(trigger.id, structuredClone(trigger));
    return trigger;
  }

  async createTrigger(input: CreateTriggerInput): Promise<Trigger> {
    const trigger = {
      id: `trig-${++triggerSeq}`,
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
    this.triggers.set(trigger.id, trigger);
    return structuredClone(trigger);
  }

  async getTrigger(triggerId: string): Promise<Trigger | undefined> {
    const t = this.triggers.get(triggerId);
    return t ? structuredClone(t) : undefined;
  }

  async listTriggersByUser(userId: string): Promise<Trigger[]> {
    return [...this.triggers.values()]
      .filter((t) => t.userId === userId)
      .map((t) => structuredClone(t));
  }

  async listDue(type: TriggerType, nowISO: string): Promise<Trigger[]> {
    return [...this.triggers.values()]
      .filter((t) => {
        if (t.type !== type || !t.enabled) return false;
        if (t.circuit.pausedAt !== null && t.circuit.pausedAt !== undefined) return false;
        // Schedule dueness = cursor (next-fire ISO) <= now; a null cursor
        // (never initialized) is due. Polled types are due every sweep.
        if (type === "schedule") return t.cursor == null || t.cursor <= nowISO;
        return true;
      })
      .map((t) => structuredClone(t));
  }

  async updateTrigger(triggerId: string, patch: UpdateTriggerInput): Promise<Trigger | undefined> {
    const t = this.triggers.get(triggerId);
    if (!t) return undefined;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.approvalId !== undefined) t.approvalId = patch.approvalId;
    if (patch.model !== undefined) t.model = patch.model;
    if (patch.budgetCents !== undefined) t.budgetCents = patch.budgetCents;
    if (patch.filters !== undefined) t.filters = patch.filters;
    if (patch.mapping !== undefined) t.mapping = patch.mapping;
    if (patch.destinations !== undefined) t.destinations = patch.destinations;
    if (patch.rateLimit !== undefined) t.rateLimit = patch.rateLimit;
    if (patch.enabled !== undefined) t.enabled = patch.enabled;
    if (patch.config !== undefined) (t as { config: unknown }).config = patch.config;
    t.updatedAt = patch.updatedAt;
    // `type` immutable; `circuit` only via the circuit ops.
    return structuredClone(t);
  }

  async recordFire(triggerId: string, result: TriggerFireRecord): Promise<void> {
    const t = this.triggers.get(triggerId);
    if (!t) return;
    t.lastFiredAt = result.lastFiredAt;
    if (result.lastRunId !== null) t.lastRunId = result.lastRunId;
    if (result.lastError !== null) t.lastError = result.lastError;
    else delete t.lastError;
    t.fireCount += 1;
  }

  async updateCursor(triggerId: string, cursor: string | null): Promise<void> {
    const t = this.triggers.get(triggerId);
    if (t) t.cursor = cursor;
  }

  async recordCircuitFailure(triggerId: string): Promise<number> {
    const t = this.triggers.get(triggerId);
    if (!t) return 0;
    t.circuit.consecutiveFailures += 1;
    return t.circuit.consecutiveFailures;
  }

  async resetCircuit(triggerId: string): Promise<void> {
    const t = this.triggers.get(triggerId);
    if (t) t.circuit = { consecutiveFailures: 0, pausedAt: null };
  }

  async setCircuitPaused(triggerId: string, pausedAt: string | null): Promise<void> {
    const t = this.triggers.get(triggerId);
    if (t) t.circuit.pausedAt = pausedAt;
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    this.triggers.delete(triggerId);
  }
}

export class InMemoryEventSourceRepo implements EventSourceRepository {
  sources = new Map<string, EventSource>();
  /** Internal signing-secret refs (never on the EventSource shape — S2). */
  signingRefs = new Map<string, string>();
  private seq = 0;

  seed(source: EventSource): EventSource {
    this.sources.set(source.id, structuredClone(source));
    return source;
  }

  async createEventSource(input: CreateEventSourceInput): Promise<EventSource> {
    const source: EventSource = {
      id: `src-${++this.seq}`,
      userId: input.userId,
      name: input.name,
      kind: input.kind,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      tokenHash: input.tokenHash,
      hasSigningSecret: input.signingSecretRef ? true : input.hasSigningSecret,
      enabled: input.enabled ?? true,
      createdAt: input.createdAt,
      eventCount: 0,
    };
    this.sources.set(source.id, source);
    if (input.signingSecretRef) this.signingRefs.set(source.id, input.signingSecretRef);
    return structuredClone(source);
  }

  async getEventSource(sourceId: string): Promise<EventSource | undefined> {
    const s = this.sources.get(sourceId);
    return s ? structuredClone(s) : undefined;
  }

  async listEventSourcesByUser(userId: string): Promise<EventSource[]> {
    return [...this.sources.values()]
      .filter((s) => s.userId === userId)
      .map((s) => structuredClone(s));
  }

  async findByTokenHash(tokenHash: string): Promise<EventSource | undefined> {
    const s = [...this.sources.values()].find((x) => x.tokenHash === tokenHash);
    return s ? structuredClone(s) : undefined;
  }

  async updateEventSource(
    sourceId: string,
    patch: UpdateEventSourceInput,
  ): Promise<EventSource | undefined> {
    const s = this.sources.get(sourceId);
    if (!s) return undefined;
    if (patch.name !== undefined) s.name = patch.name;
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
    if (patch.tokenHash !== undefined) s.tokenHash = patch.tokenHash;
    if (patch.signingSecretRef !== undefined) {
      if (patch.signingSecretRef === null) this.signingRefs.delete(sourceId);
      else this.signingRefs.set(sourceId, patch.signingSecretRef);
      s.hasSigningSecret = patch.signingSecretRef !== null;
    }
    return structuredClone(s);
  }

  async getSigningSecretRef(sourceId: string): Promise<string | undefined> {
    return this.signingRefs.get(sourceId);
  }

  async recordEvent(sourceId: string, receivedAt: string): Promise<void> {
    const s = this.sources.get(sourceId);
    if (!s) return;
    s.lastEventAt = receivedAt;
    s.eventCount += 1;
  }

  async deleteEventSource(sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
  }
}

/** Ring-buffer received-event fake: capped per source (oldest evicted). */
export class InMemoryReceivedEventRepo implements ReceivedEventRepository {
  /** Per-source buffers, oldest → newest. */
  events = new Map<string, ReceivedEvent[]>();

  constructor(readonly capPerSource = 25) {}

  async appendEvent(input: AppendReceivedEventInput): Promise<ReceivedEvent> {
    const event: ReceivedEvent = {
      id: `evt-${++receivedEventSeq}`,
      sourceId: input.sourceId,
      name: input.name,
      receivedAt: input.receivedAt,
      payload: input.payload,
    };
    const buffer = this.events.get(input.sourceId) ?? [];
    buffer.push(event);
    while (buffer.length > this.capPerSource) buffer.shift();
    this.events.set(input.sourceId, buffer);
    return structuredClone(event);
  }

  async listEventsBySource(sourceId: string, limit = 50): Promise<ReceivedEvent[]> {
    const buffer = this.events.get(sourceId) ?? [];
    return [...buffer]
      .reverse()
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  async getEvent(eventId: string): Promise<ReceivedEvent | undefined> {
    for (const buffer of this.events.values()) {
      const found = buffer.find((e) => e.id === eventId);
      if (found) return structuredClone(found);
    }
    return undefined;
  }

  async pruneEvents(sourceId: string): Promise<number> {
    const buffer = this.events.get(sourceId) ?? [];
    let removed = 0;
    while (buffer.length > this.capPerSource) {
      buffer.shift();
      removed += 1;
    }
    return removed;
  }
}

/** Fire-log fake: capped per trigger (oldest evicted), newest-first listing. */
export class InMemoryFireLogRepo implements FireLogRepository {
  /** Per-trigger rows, oldest → newest. */
  logs = new Map<string, TriggerFireLog[]>();

  constructor(readonly capPerTrigger = 200) {}

  seed(log: TriggerFireLog): TriggerFireLog {
    const rows = this.logs.get(log.triggerId) ?? [];
    rows.push(structuredClone(log));
    this.logs.set(log.triggerId, rows);
    return log;
  }

  async appendFireLog(input: AppendFireLogInput): Promise<TriggerFireLog> {
    const log: TriggerFireLog = {
      id: `fire-${++fireLogSeq}`,
      triggerId: input.triggerId,
      at: input.at,
      outcome: input.outcome,
      runId: input.runId ?? null,
      detail: input.detail ?? null,
    };
    const rows = this.logs.get(input.triggerId) ?? [];
    rows.push(log);
    while (rows.length > this.capPerTrigger) rows.shift();
    this.logs.set(input.triggerId, rows);
    return structuredClone(log);
  }

  async listFireLogsByTrigger(triggerId: string, limit = 100): Promise<TriggerFireLog[]> {
    const rows = this.logs.get(triggerId) ?? [];
    return [...rows]
      .reverse()
      .slice(0, limit)
      .map((l) => structuredClone(l));
  }
}

/** A scripted CanStartRun port fake that records calls. */
export interface FakeCanStart {
  fn: CanStartRun;
  calls: CanStartRunRequest[];
}

export function fakeCanStart(
  allowed: boolean,
  reason?: CanStartRunReason,
  detail?: string,
): FakeCanStart {
  const calls: CanStartRunRequest[] = [];
  const fn: CanStartRun = async (req) => {
    calls.push(req);
    return {
      allowed,
      ...(reason !== undefined ? { reason } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Persisted-output + connection fakes (Wave 3a)
// ---------------------------------------------------------------------------

/** In-memory OutputStore: bytes keyed by storeKey; presign returns a fake URL. */
export class InMemoryOutputStore implements OutputStore {
  objects = new Map<string, Uint8Array>();
  /** When set, putRunOutput throws for matching paths (failure injection). */
  failPaths = new Set<string>();

  async putRunOutput(runId: string, path: string, bytes: Uint8Array): Promise<string> {
    if (this.failPaths.has(path)) throw new Error(`put failed: ${path}`);
    const key = `auto-outputs/${runId}/${path}`;
    this.objects.set(key, bytes);
    return key;
  }
  async presignGet(storeKey: string): Promise<string> {
    return `https://outputs.example/presigned/${encodeURIComponent(storeKey)}`;
  }
  async getRunOutput(storeKey: string): Promise<Uint8Array> {
    const bytes = this.objects.get(storeKey);
    if (!bytes) throw new Error(`no such object: ${storeKey}`);
    return bytes;
  }
  async delete(storeKey: string): Promise<void> {
    this.objects.delete(storeKey);
  }
}

/** In-memory SecretStore (PLAINTEXT — tests only; the real stores encrypt). */
export class InMemorySecretStore implements SecretStore {
  secrets = new Map<string, string>();
  private seq = 0;

  async put(plaintext: string): Promise<string> {
    const ref = `sref-${++this.seq}`;
    this.secrets.set(ref, plaintext);
    return ref;
  }
  async reveal(secretRef: string): Promise<string> {
    const v = this.secrets.get(secretRef);
    if (v === undefined) throw new Error(`Unknown secretRef: ${secretRef}`);
    return v;
  }
  async delete(secretRef: string): Promise<void> {
    this.secrets.delete(secretRef);
  }
}

let connectionSeq = 0;

export class InMemoryConnectionRepo implements ConnectionRepository {
  connections = new Map<string, Connection>();

  seed(connection: Connection): Connection {
    this.connections.set(connection.id, structuredClone(connection));
    return connection;
  }

  async createConnection(input: CreateConnectionInput): Promise<Connection> {
    const connection: Connection = {
      id: `conn-${++connectionSeq}`,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      name: input.name,
      type: input.type,
      config: input.config,
      secretRef: input.secretRef ?? null,
      status: "unverified",
      createdAt: input.createdAt,
    };
    this.connections.set(connection.id, structuredClone(connection));
    return structuredClone(connection);
  }

  async getConnection(connectionId: string): Promise<Connection | undefined> {
    const c = this.connections.get(connectionId);
    return c ? structuredClone(c) : undefined;
  }

  async listConnectionsByOwner(
    ownerType: ConnectionOwnerType,
    ownerId: string,
  ): Promise<Connection[]> {
    return [...this.connections.values()]
      .filter((c) => c.ownerType === ownerType && c.ownerId === ownerId)
      .map((c) => structuredClone(c));
  }

  async updateConnection(
    connectionId: string,
    patch: UpdateConnectionInput,
  ): Promise<Connection | undefined> {
    const c = this.connections.get(connectionId);
    if (!c) return undefined;
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.config !== undefined) c.config = patch.config;
    if (patch.secretRef !== undefined) c.secretRef = patch.secretRef;
    return structuredClone(c);
  }

  async setConnectionStatus(
    connectionId: string,
    status: ConnectionStatus,
    lastUsedAt?: string,
  ): Promise<void> {
    const c = this.connections.get(connectionId);
    if (!c) return;
    c.status = status;
    if (lastUsedAt !== undefined) c.lastUsedAt = lastUsedAt;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
  }
}
