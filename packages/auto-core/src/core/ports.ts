/**
 * Ports: the runtime- and cloud-agnostic interfaces the Auto core depends on.
 *
 * Each storage port has two adapters (see ../adapters):
 *   - aws/      → DynamoDB (+ S3 / tmp dir for workspaces)
 *   - selfhost/ → Postgres (+ local disk for workspaces)
 *
 * The core (sandbox-executor, run-driver, worker) MUST depend ONLY on these
 * ports — never on a concrete adapter or cloud SDK — so the domain logic is
 * identical across hosted and self-hosted runtimes (mirrors gateway-core /
 * market-core).
 *
 * Billing + the chat/tool engine are NOT re-declared here: Auto reuses
 * @agentkitforge/gateway-core's ChatProvider + CreditLedgerRepository +
 * runManagedTurn directly. The run-driver takes those as injected deps.
 */

import type {
  AppendFireLogInput,
  AppendReceivedEventInput,
  AuditEntry,
  AutoApproval,
  AutoRun,
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
  CreateEventSourceInput,
  CreatePendingApprovalInput,
  CreateRunInput,
  CreateScheduleInput,
  CreateTriggerInput,
  CreateWebhookInput,
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
  WorkspaceFileEntry,
} from "./types.js";

/** Application configuration + secrets, sourced per runtime. */
export interface ConfigProvider {
  /** Returns a config value; throws if `required` and missing. */
  get(key: string, required?: boolean): string | undefined;
}

// ---------------------------------------------------------------------------
// AutoRunRepository
// ---------------------------------------------------------------------------

/**
 * Persists run lifecycle, audit, spend, result, and the kill-switch flag.
 *
 * INVARIANTS:
 *   - auditLog is append-only (appendAudit never rewrites prior entries).
 *   - spentCents only increases (recordSpend adds).
 *   - requestCancel is idempotent; isCancelRequested reflects the latest flag.
 */
export interface AutoRunRepository {
  createRun(input: CreateRunInput): Promise<AutoRun>;
  getRun(runId: string): Promise<AutoRun | undefined>;
  listRunsByUser(userId: string, limit?: number): Promise<AutoRun[]>;
  /** Updates status and optionally stamps startedAt/finishedAt/error plus the
   *  billing-split totals (spentInferenceCents/spentComputeCents). */
  updateRunStatus(
    runId: string,
    status: AutoRunStatus,
    fields?: {
      startedAt?: string;
      finishedAt?: string;
      error?: string;
      workspaceId?: string;
      spentInferenceCents?: number;
      spentComputeCents?: number;
    },
  ): Promise<AutoRun | undefined>;
  /** Appends one audit entry (never replaces existing entries). */
  appendAudit(runId: string, entry: AuditEntry): Promise<void>;
  /** Sets the terminal result (final output + workspace manifest). */
  setResult(runId: string, result: AutoRunResult): Promise<void>;
  /** Adds to spentCents and returns the new total. */
  recordSpend(runId: string, deltaCents: number): Promise<number>;
  /** Kill-switch: mark the run for cancellation (idempotent). */
  requestCancel(runId: string): Promise<void>;
  /** Kill-switch read: true if a cancel was requested. */
  isCancelRequested(runId: string): Promise<boolean>;
  /**
   * OPTIONAL: the number of ACTIVE (queued/running) runs the user has — the L4
   * concurrency-cap read. Optional so existing fakes/adapters keep compiling;
   * the pg + dynamo adapters implement it natively, and the
   * `countActiveRuns()` helper (core/concurrency.ts) falls back to a
   * newest-first `listRunsByUser` scan when a repository lacks it.
   */
  countActiveRuns?(userId: string): Promise<number>;
  /**
   * OPTIONAL: sets the run's PERSISTED-OUTPUT manifest (`run.outputFiles`) —
   * the durable OutputStore-backed manifest written by the worker harness
   * after a run reaches a terminal status. Optional so existing fakes keep
   * compiling; the pg + dynamo adapters implement it, and the output-persist
   * step silently skips manifest writes when a repository lacks it.
   */
  setOutputFiles?(runId: string, files: AutoRunOutputFile[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// AutoApprovalRepository
// ---------------------------------------------------------------------------

/** Persists standing approvals. */
export interface AutoApprovalRepository {
  createApproval(input: CreateApprovalInput): Promise<AutoApproval>;
  /** Returns the non-revoked approval matching (userId, kitRef), if any. */
  getApprovalForKit(userId: string, kitRef: KitRef): Promise<AutoApproval | undefined>;
  listApprovalsByUser(userId: string): Promise<AutoApproval[]>;
  /** Flips an approval to revoked; returns the updated row or undefined. */
  revokeApproval(approvalId: string, revokedAt: string): Promise<AutoApproval | undefined>;
}

// ---------------------------------------------------------------------------
// AutoScheduleRepository (Phase B)
// ---------------------------------------------------------------------------

/** The result fields the scheduler stamps after firing (or skipping) a schedule. */
export interface ScheduleRunResult {
  /** When the schedule was processed this sweep (ISO). */
  lastRunAt: string;
  /** Run id produced by the fire, or null when the fire was skipped. */
  lastRunId: string | null;
  /** The recomputed next fire time (ISO) — always advanced to avoid hot-loops. */
  nextRunAt: string;
  /** Skip reason / dispatch error, or null when the fire was clean. */
  lastError: string | null;
}

/**
 * Persists standing schedules (Phase B).
 *
 * INVARIANTS:
 *   - listDueSchedules returns ENABLED schedules whose nextRunAt <= now.
 *   - setScheduleRunResult always advances nextRunAt (the scheduler computes the
 *     next fire BEFORE dispatch and persists it) so a re-entrant sweep within
 *     the same minute cannot double-fire.
 */
export interface AutoScheduleRepository {
  createSchedule(input: CreateScheduleInput): Promise<AutoSchedule>;
  getSchedule(scheduleId: string): Promise<AutoSchedule | undefined>;
  listSchedulesByUser(userId: string): Promise<AutoSchedule[]>;
  /** Enabled schedules due to fire (nextRunAt <= nowISO). */
  listDueSchedules(nowISO: string): Promise<AutoSchedule[]>;
  /** Edits a schedule (enable/disable/edit); returns the updated row or undefined. */
  updateSchedule(
    scheduleId: string,
    patch: UpdateScheduleInput,
  ): Promise<AutoSchedule | undefined>;
  /** Records the outcome of a fire/skip (lastRunAt/lastRunId/nextRunAt/lastError). */
  setScheduleRunResult(scheduleId: string, result: ScheduleRunResult): Promise<void>;
  deleteSchedule(scheduleId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// AutoWebhookRepository (Phase C)
// ---------------------------------------------------------------------------

/**
 * Persists standing webhook triggers (Phase C).
 *
 * INVARIANTS:
 *   - `secretHash` is stored verbatim; the plaintext secret is NEVER persisted.
 *   - recordFire is additive on fireCount and stamps lastFiredAt/lastRunId.
 *   - getWebhook returns the webhook regardless of enabled state (consumeWebhook
 *     enforces the enabled check so it can return a typed disabled error).
 */
export interface AutoWebhookRepository {
  createWebhook(input: CreateWebhookInput): Promise<AutoWebhook>;
  getWebhook(webhookId: string): Promise<AutoWebhook | undefined>;
  listWebhooksByUser(userId: string): Promise<AutoWebhook[]>;
  /** Stamps the outcome of a successful fire (lastFiredAt/lastRunId, ++fireCount). */
  recordFire(webhookId: string, result: WebhookFireResult): Promise<void>;
  /** Enables/disables a webhook; returns the updated row or undefined. */
  setEnabled(webhookId: string, enabled: boolean): Promise<AutoWebhook | undefined>;
  deleteWebhook(webhookId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InputStore (Phase C — out-of-band per-run input files)
// ---------------------------------------------------------------------------

/**
 * Stages + hydrates per-run input files supplied OUT-OF-BAND (the web layer
 * uploads them — e.g. via presigned S3 PUT — then records the manifest on the
 * run). The worker hydrates them into the run workspace's `inputs/` subdir
 * BEFORE execution. All filenames are path-confined (no traversal/symlink
 * escape) exactly like every other workspace op.
 *
 *   - aws/      → S3 under a per-run prefix `auto-inputs/{runId}/...`.
 *   - selfhost/ → local disk / MinIO under a per-run dir.
 */
export interface InputStore {
  /**
   * Records/uploads staged input files for a run and returns the manifest to
   * persist on the run. (The web layer typically uploads bytes via presigned
   * URLs; this method may be a no-op manifest builder in that flow, or it may
   * accept inline content for the self-host/local path.)
   */
  stageInputs(runId: string, files: StagedInputFile[]): Promise<AutoRunInputFileRef[]>;
  /**
   * Copies every staged input file for a run into the workspace under `inputs/`,
   * path-confined. Returns the workspace-relative paths written.
   */
  hydrateInputsIntoWorkspace(
    runId: string,
    workspace: WorkspaceStore,
    workspaceId: string,
    manifest: AutoRunInputFileRef[],
  ): Promise<string[]>;
}

/** An input file presented for staging (inline content or a backing key). */
export interface StagedInputFile {
  /** Workspace-relative path (placed under `inputs/`); path-confined. */
  path: string;
  /** Inline UTF-8 content (self-host/local) — mutually exclusive with s3Key. */
  content?: string;
  /** Pre-uploaded backing object key (aws presigned flow). */
  s3Key?: string;
}

// ---------------------------------------------------------------------------
// EmailSender (Phase D — opt-in result delivery)
// ---------------------------------------------------------------------------

/** One email to deliver (the DeliveryService builds the subject + body). */
export interface OutboundEmail {
  /** Recipient addresses (basic-format validated upstream). */
  to: string[];
  subject: string;
  /** Plain-text body (always present). */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

/**
 * Sends a notification email (Phase D result delivery). Provider-specific:
 *   - aws/      → SES v2 (`SendEmailCommand`), sender from env `SES_SENDER`. When
 *                 `SES_SENDER` is unset the implementation is an INERT no-op
 *                 (returns `{ status: "skipped" }`) so missing config can never
 *                 break a run.
 *   - selfhost/ → nodemailer SMTP, configured via `SMTP_HOST`/`SMTP_FROM` (+ optional
 *                 `SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`). INERT (skipped)
 *                 when `SMTP_HOST` or `SMTP_FROM` is unset so unconfigured deployments
 *                 never break (webhook delivery still works).
 *
 * The implementation MUST NOT throw on a delivery failure — it returns a
 * `{ status: "failed", error }` outcome so the run is never affected.
 */
export interface EmailSender {
  sendEmail(email: OutboundEmail): Promise<EmailSendResult>;
}

/** The result of one `EmailSender.sendEmail` call. */
export interface EmailSendResult {
  status: "delivered" | "failed" | "skipped";
  /** Failure / skip detail (absent on a clean delivery). */
  error?: string;
}

// ---------------------------------------------------------------------------
// WorkspaceStore (the "hands" substrate)
// ---------------------------------------------------------------------------

/**
 * Per-run ephemeral workspace. The sandbox executor is the ONLY thing that
 * touches it, and every path it passes is canonicalized + confined to the
 * workspace root by the implementation (starts-with check + traversal/symlink
 * rejection). There is NO run_command — the workspace exposes file ops only.
 */
export interface WorkspaceStore {
  /** Creates a fresh workspace for a run; returns an opaque workspaceId. */
  createWorkspace(runId: string): Promise<string>;
  /** Reads a UTF-8 file scoped to the workspace. Throws on escape / missing. */
  readFile(workspaceId: string, path: string): Promise<string>;
  /** Lists directory entries (relative paths) scoped to the workspace. */
  listDir(workspaceId: string, path: string): Promise<string[]>;
  /** Writes a UTF-8 file scoped to the workspace (creating parent dirs). */
  writeFile(workspaceId: string, path: string, content: string): Promise<void>;
  /** Returns the manifest of all files in the workspace (for the run result). */
  bundleResult(workspaceId: string): Promise<WorkspaceFileEntry[]>;
  /** Tears down the workspace and frees its storage. */
  cleanup(workspaceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// TriggerRepository (event-driven expansion — unified triggers)
// ---------------------------------------------------------------------------

/**
 * Persists unified Trigger records (the event-driven expansion; INTERFACE ONLY
 * in this workstream — adapters land later).
 *
 * INVARIANTS:
 *   - A trigger never widens consent: fires are still approval- and
 *     budget-gated by the run-create path; the repository just stores state.
 *   - recordFire is additive on fireCount and stamps lastFiredAt/lastRunId.
 *   - listDue returns ENABLED triggers of `type` that are not circuit-paused;
 *     for type "schedule" dueness = cursor (next-fire ISO) <= nowISO, for
 *     polled types (watch/rss/run_completed/email_in) every enabled trigger of
 *     the type is due each sweep (the poller consults `cursor` itself).
 *   - Circuit ops are the ONLY writers of `circuit`; updateTrigger never
 *     touches it.
 */
export interface TriggerRepository {
  createTrigger(input: CreateTriggerInput): Promise<Trigger>;
  getTrigger(triggerId: string): Promise<Trigger | undefined>;
  listTriggersByUser(userId: string): Promise<Trigger[]>;
  /** Enabled, non-circuit-paused triggers of `type` due at nowISO (see above). */
  listDue(type: TriggerType, nowISO: string): Promise<Trigger[]>;
  /** Edits a trigger (`type` is immutable); returns the updated row or undefined. */
  updateTrigger(triggerId: string, patch: UpdateTriggerInput): Promise<Trigger | undefined>;
  /** Stamps the outcome of a fire (lastFiredAt/lastRunId/lastError, ++fireCount). */
  recordFire(triggerId: string, result: TriggerFireRecord): Promise<void>;
  /** Persists the poll/schedule resume cursor (null clears it). */
  updateCursor(triggerId: string, cursor: string | null): Promise<void>;
  /** ++circuit.consecutiveFailures; returns the new count. */
  recordCircuitFailure(triggerId: string): Promise<number>;
  /** Resets circuit.consecutiveFailures to 0 and clears pausedAt. */
  resetCircuit(triggerId: string): Promise<void>;
  /** Pauses (pausedAt = ISO) or unpauses (null) the trigger's circuit breaker. */
  setCircuitPaused(triggerId: string, pausedAt: string | null): Promise<void>;
  deleteTrigger(triggerId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// EventSourceRepository (user-created ingest endpoints)
// ---------------------------------------------------------------------------

/**
 * Persists EventSource records (INTERFACE ONLY in this workstream).
 *
 * INVARIANTS:
 *   - `tokenHash` is stored verbatim; the plaintext ingest bearer token is
 *     NEVER persisted (S2 — mirrors AutoWebhookRepository.secretHash).
 *   - findByTokenHash is the ingest auth lookup: the route hashes the presented
 *     bearer token (sha256 hex) and looks the source up by that hash — the
 *     comparison happens on hashes, never plaintext.
 *   - recordEvent is additive on eventCount and stamps lastEventAt.
 */
export interface EventSourceRepository {
  createEventSource(input: CreateEventSourceInput): Promise<EventSource>;
  getEventSource(sourceId: string): Promise<EventSource | undefined>;
  listEventSourcesByUser(userId: string): Promise<EventSource[]>;
  /** Ingest auth: the source whose tokenHash matches, regardless of enabled
   *  state (the route enforces the enabled check for a typed error). */
  findByTokenHash(tokenHash: string): Promise<EventSource | undefined>;
  /**
   * The SecretStore handle of the source's provider HMAC signing secret, or
   * undefined when none is configured. INTERNAL-ONLY: the ref never appears on
   * the EventSource contract shape (S2 — responses carry only
   * `hasSigningSecret`); the ingest route resolves it here and reveals the
   * plaintext through the SecretStore for signature verification.
   */
  getSigningSecretRef(sourceId: string): Promise<string | undefined>;
  /** Edits name/enabled; returns the updated row or undefined. */
  updateEventSource(
    sourceId: string,
    patch: UpdateEventSourceInput,
  ): Promise<EventSource | undefined>;
  /** Stamps lastEventAt and ++eventCount after an accepted ingest. */
  recordEvent(sourceId: string, receivedAt: string): Promise<void>;
  deleteEventSource(sourceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ReceivedEventRepository (inspector ring buffer)
// ---------------------------------------------------------------------------

/**
 * Persists the received-event inspector buffer (INTERFACE ONLY in this
 * workstream). RING-BUFFER SEMANTICS: entries are capped PER SOURCE (append
 * evicts the oldest beyond the cap) and TTL'd (implementations expire old
 * entries; prune enforces both). Payloads are already size-capped at ingest
 * (EVENT_PAYLOAD_MAX_BYTES) — this store never sees larger bodies.
 */
export interface ReceivedEventRepository {
  /** Appends one event (id assigned), evicting beyond the per-source cap. */
  appendEvent(input: AppendReceivedEventInput): Promise<ReceivedEvent>;
  /** Newest-first events for a source (inspector listing). */
  listEventsBySource(sourceId: string, limit?: number): Promise<ReceivedEvent[]>;
  getEvent(eventId: string): Promise<ReceivedEvent | undefined>;
  /** Evicts over-cap / past-TTL entries for a source; returns the count removed. */
  pruneEvents(sourceId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// ConnectionRepository (non-secret connection records)
// ---------------------------------------------------------------------------

/**
 * Persists Connection records (INTERFACE ONLY in this workstream).
 *
 * SECRETS NEVER TRAVEL THROUGH THIS PORT (S2): a connection's credential lives
 * in the SecretStore; this repository stores only the opaque `secretRef`
 * handle plus NON-SECRET config (schema-refined to reject secret-looking
 * keys). Plaintext put/reveal is SecretStore-only.
 */
export interface ConnectionRepository {
  createConnection(input: CreateConnectionInput): Promise<Connection>;
  getConnection(connectionId: string): Promise<Connection | undefined>;
  listConnectionsByOwner(
    ownerType: ConnectionOwnerType,
    ownerId: string,
  ): Promise<Connection[]>;
  /** Edits name/config/secretRef; returns the updated row or undefined. */
  updateConnection(
    connectionId: string,
    patch: UpdateConnectionInput,
  ): Promise<Connection | undefined>;
  /** Stamps the verification status (+ optionally lastUsedAt). */
  setConnectionStatus(
    connectionId: string,
    status: ConnectionStatus,
    lastUsedAt?: string,
  ): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// SecretStore (encrypted-at-rest secret material — S2 invariant)
// ---------------------------------------------------------------------------

/**
 * Stores secret material ENCRYPTED AT REST behind opaque `secretRef` handles
 * (INTERFACE ONLY in this workstream). Used ONLY by the worker harness /
 * server delivery+verification paths (HMAC signature checks, connection
 * credentials) — NEVER exposed to agent tools, never interpolated into
 * prompts, never present in any contract shape (S2 invariant). Unlike our own
 * bearer tokens (stored as hashes), these must be RECOVERABLE: HMAC
 * verification and downstream delivery need the plaintext.
 */
export interface SecretStore {
  /** Encrypts + stores the plaintext; returns the opaque secretRef handle. */
  put(plaintext: string): Promise<string>;
  /** Decrypts + returns the plaintext for a handle (server/worker-only). */
  reveal(secretRef: string): Promise<string>;
  /** Destroys the stored secret (handle becomes invalid). */
  delete(secretRef: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// OutputStore (persisted run outputs)
// ---------------------------------------------------------------------------

/**
 * Persists run output files DURABLY (INTERFACE ONLY in this workstream) —
 * backing the run's `outputFiles` manifest, distinct from the ephemeral
 * workspace (`result.files`). Presigned GETs let the UI/destinations download
 * without proxying bytes.
 */
export interface OutputStore {
  /** Stores one output file; returns the storeKey for the run manifest. */
  putRunOutput(runId: string, path: string, bytes: Uint8Array): Promise<string>;
  /** Time-limited download URL for a stored output. */
  presignGet(storeKey: string): Promise<string>;
  /** Deletes a stored output (retention/expiry sweep). */
  delete(storeKey: string): Promise<void>;
  /**
   * OPTIONAL: reads a stored output's bytes server-side (the destination
   * executor's S3-copy path). When absent, the executor falls back to fetching
   * the presigned GET URL through its injected fetch.
   */
  getRunOutput?(storeKey: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// FireLogRepository (abuse/cost observability)
// ---------------------------------------------------------------------------

/**
 * Persists trigger fire-log rows (INTERFACE ONLY in this workstream).
 * Suppressed/filtered/skipped fires land HERE, never as fake run records —
 * the runs table stays real executions only. Storage is capped per trigger
 * (implementations evict the oldest rows beyond the cap).
 */
export interface FireLogRepository {
  /** Appends one fire-log row (id assigned), evicting beyond the per-trigger cap. */
  appendFireLog(input: AppendFireLogInput): Promise<TriggerFireLog>;
  /** Newest-first fire logs for a trigger, capped. */
  listFireLogsByTrigger(triggerId: string, limit?: number): Promise<TriggerFireLog[]>;
}

// ---------------------------------------------------------------------------
// PendingApprovalRepository (Wave 4 — held requireApproval fires)
// ---------------------------------------------------------------------------

/**
 * Persists HELD trigger fires awaiting an explicit Approve/Deny (Wave 4
 * `requireApproval`).
 *
 * INVARIANTS:
 *   - `tokenHash` is stored verbatim; the one-time plaintext approval token is
 *     NEVER persisted (S2 — mirrors EventSource.tokenHash).
 *   - resolvePending flips status ONLY from "pending" (a second Approve click,
 *     a Deny after Approve, or an expiry race returns undefined — the fire can
 *     never execute twice). S4: approve re-presents the held event through the
 *     FULL gate chain; nothing here touches in-flight runs.
 */
export interface PendingApprovalRepository {
  createPending(input: CreatePendingApprovalInput): Promise<PendingTriggerApproval>;
  getPending(pendingId: string): Promise<PendingTriggerApproval | undefined>;
  /** Callback auth lookup: the pending row whose tokenHash matches (the caller
   *  hashes the presented one-time token — comparison happens on hashes). */
  findByTokenHash(tokenHash: string): Promise<PendingTriggerApproval | undefined>;
  /**
   * Atomically resolves a PENDING row to approved/denied/expired, stamping
   * resolvedAt. Returns the updated row, or undefined when the row is missing
   * OR already resolved (single-consume guarantee).
   */
  resolvePending(
    pendingId: string,
    status: "approved" | "denied" | "expired",
    resolvedAt: string,
  ): Promise<PendingTriggerApproval | undefined>;
  deletePending(pendingId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Composed dependency bundle
// ---------------------------------------------------------------------------

/**
 * The event-driven-expansion storage bundle (unified triggers + event sources +
 * the inspector ring buffer + fire logs). Grouped so AutoStorageDeps stays
 * BACKWARD-COMPATIBLE: existing fakes/stubs that build the legacy bundle keep
 * compiling (`events` is optional there), while both persistent adapters always
 * populate it.
 */
export interface EventStorageDeps {
  triggers: TriggerRepository;
  eventSources: EventSourceRepository;
  receivedEvents: ReceivedEventRepository;
  fireLogs: FireLogRepository;
  /** Encrypted-at-rest provider signing secrets + connection credentials (S2).
   *  Throws the typed SecretStoreUnconfiguredError until
   *  AUTO_SECRET_ENCRYPTION_KEY is set. */
  secrets: SecretStore;
  /** Non-secret Connection records (credentials live in `secrets` behind the
   *  opaque secretRef — S2). Both persistent adapters populate it. */
  connections: ConnectionRepository;
  /**
   * Wave 4: held requireApproval fires. OPTIONAL for backward compatibility
   * with existing fakes/stubs (both persistent adapters populate it); when
   * absent, requireApproval triggers FAIL CLOSED (error fire log, no run).
   */
  pendingApprovals?: PendingApprovalRepository;
}

/** The storage-layer dependencies, produced by makeAutoDeps({ backend }). */
export interface AutoStorageDeps {
  runs: AutoRunRepository;
  approvals: AutoApprovalRepository;
  workspaces: WorkspaceStore;
  /** Phase B: standing schedules. */
  schedules: AutoScheduleRepository;
  /** Phase C: standing webhooks (inbound event triggers). */
  webhooks: AutoWebhookRepository;
  /** Phase C: staged per-run input files. */
  inputs: InputStore;
  /**
   * Event-driven expansion stores (triggers/event-sources/received-events/
   * fire-logs). OPTIONAL for backward compatibility with existing fakes and
   * stubs; the pg + dynamo adapters ALWAYS populate it.
   */
  events?: EventStorageDeps;
  /**
   * Persisted run outputs (durable, presigned-download-backed). OPTIONAL:
   * absent when no outputs bucket is configured (env/config) — the worker
   * then skips output persistence silently and the run manifest stays
   * `result.files`-only (deploy-safe).
   */
  outputs?: OutputStore;
}
