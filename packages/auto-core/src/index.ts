/**
 * @agentkitforge/auto-core public API surface (Phase A).
 *
 * AgentKitAuto: hosted, on-demand, run-to-completion autonomous Agent Kit runs.
 * Reuses @agentkitforge/gateway-core's engine (managed-turn billing + pricing);
 * adds a non-interactive policy-gated sandbox executor (the hands), standing
 * approvals, a REQUIRED per-run budget cap, a kill-switch, lifecycle + audit,
 * and AWS + self-host adapters.
 *
 * The worker entrypoint is also available as a subpath export:
 *   @agentkitforge/auto-core/entrypoints/worker
 */

// ---- Core types ----------------------------------------------------------
export type {
  AuditEntry,
  ApprovalScope,
  AutoApproval,
  AutoRun,
  AutoRunInput,
  AutoRunInputFile,
  AutoRunInputFileRef,
  AutoRunResult,
  AutoRunStatus,
  AutoSchedule,
  AutoWebhook,
  CreateApprovalInput,
  CreateRunInput,
  CreateScheduleInput,
  CreateWebhookInput,
  DeliveryChannelOutcome,
  DeliveryChannelStatus,
  DeliveryConfig,
  DeliveryOutcome,
  DeliveryWebhook,
  InferenceMode,
  KitRef,
  NetworkPolicy,
  RunTrigger,
  UpdateScheduleInput,
  WebhookFireResult,
  WorkspaceFileEntry,
} from "./core/types.js";
export {
  autoApprovalSchema,
  autoRunInputFileRefSchema,
  autoRunInputFileSchema,
  autoRunInputSchema,
  autoRunStatusSchema,
  autoScheduleSchema,
  autoWebhookSchema,
  deliveryConfigSchema,
  deliveryWebhookSchema,
  DENY_ALL_NETWORK_POLICY,
  kitRefKey,
  kitRefSchema,
  networkPolicySchema,
  normalizeNetworkPolicy,
  validateDeliveryConfig,
} from "./core/types.js";

// ---- Event-driven expansion types (contracts-first; interfaces only) ------
export type {
  AppendFireLogInput,
  AppendReceivedEventInput,
  AutoRunOutputFile,
  CanStartRunReason,
  CanStartRunRequest,
  CanStartRunResponse,
  Connection,
  ConnectionConfig,
  ConnectionOwnerType,
  ConnectionStatus,
  ConnectionType,
  CreateConnectionInput,
  CreateEventSourceInput,
  CreateTriggerInput,
  CreateTriggerRequest,
  Destination,
  EventSource,
  EventSourceKind,
  EventSourceProvider,
  PublicEventSource,
  ReceivedEvent,
  ReceivedEventDelivery,
  RunTerminalStatus,
  Trigger,
  TriggerCircuit,
  TriggerConfig,
  TriggerFilter,
  TriggerFilterOp,
  TriggerFireLog,
  TriggerFireOutcome,
  TriggerFireRecord,
  TriggerMapping,
  TriggerRateLimit,
  TriggerType,
  UpdateConnectionInput,
  UpdateEventSourceInput,
  UpdateTriggerInput,
  UpdateTriggerRequest,
} from "./core/types.js";
export {
  CAN_START_FAIL_CLOSED_MODES,
  EVENT_PAYLOAD_MAX_BYTES,
  MAPPING_FIELD_INTERPOLATION_MAX_CHARS,
  MAPPING_TOTAL_PROMPT_MAX_CHARS,
  autoRunOutputFileSchema,
  canStartRunReasonSchema,
  canStartRunRequestSchema,
  canStartRunResponseSchema,
  connectionConfigSchema,
  connectionOwnerTypeSchema,
  connectionSchema,
  connectionStatusSchema,
  connectionTypeSchema,
  destinationSchema,
  eventNameSchema,
  eventSourceKindSchema,
  eventSourceProviderSchema,
  eventSourceSchema,
  publicEventSourceSchema,
  receivedEventSchema,
  runTerminalStatusSchema,
  triggerCircuitSchema,
  triggerFilterSchema,
  triggerFireLogSchema,
  triggerFireOutcomeSchema,
  triggerMappingSchema,
  triggerRateLimitSchema,
  triggerSchema,
  triggerTypeSchema,
} from "./core/types.js";

// ---- Ports ---------------------------------------------------------------
export type {
  AutoApprovalRepository,
  AutoRunRepository,
  AutoScheduleRepository,
  AutoStorageDeps,
  AutoWebhookRepository,
  ConfigProvider,
  ConnectionRepository,
  EmailSender,
  EmailSendResult,
  EventSourceRepository,
  EventStorageDeps,
  FireLogRepository,
  InputStore,
  OutboundEmail,
  OutputStore,
  ReceivedEventRepository,
  ScheduleRunResult,
  SecretStore,
  StagedInputFile,
  TriggerRepository,
  WorkspaceStore,
} from "./core/ports.js";

// ---- Event-store caps (ring-buffer semantics; enforced by both adapters) --
export {
  FIRE_LOGS_PER_TRIGGER_CAP,
  RECEIVED_EVENTS_PER_SOURCE_CAP,
  RECEIVED_EVENT_TTL_MS,
} from "./core/event-limits.js";

// ---- SecretStore crypto (provider signing secrets — S2) -------------------
export {
  AUTO_SECRET_KEY_ENV_VAR,
  SecretStoreUnconfiguredError,
  decryptSecret,
  encryptSecret,
  loadSecretEncryptionKey,
} from "./core/secret-crypto.js";
export type { EncryptedSecret } from "./core/secret-crypto.js";

// ---- Cron utils (Phase B) ------------------------------------------------
export { nextFireAfter, parseCron, validateCron, CronParseError } from "./core/cron.js";
export type { ParsedCron } from "./core/cron.js";

// ---- Schedule runner (Phase B) -------------------------------------------
export { runDueSchedules } from "./core/schedule-runner.js";
export type {
  CreateAndDispatch,
  RunDueSchedulesArgs,
  RunDueSchedulesDeps,
  ScheduleSweepError,
  ScheduleSweepSummary,
} from "./core/schedule-runner.js";

// ---- Webhook triggers (Phase C) ------------------------------------------
export { consumeWebhook, WebhookError } from "./core/webhook-runner.js";
export type {
  ConsumeWebhookArgs,
  CreateAndDispatchWebhookRun,
  WebhookErrorReason,
} from "./core/webhook-runner.js";
export {
  generateWebhookSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
} from "./core/webhook-secret.js";

// ---- Event-driven trigger execution (mapping / verifiers / runner) --------
export {
  buildRunInput,
  evaluateFilters,
  isSafeMatchPattern,
  MATCH_PATTERN_MAX_LENGTH,
  renderPrompt,
  resolvePath,
} from "./core/mapping-evaluator.js";
export type { FilterEvaluation, ResolvedPath } from "./core/mapping-evaluator.js";
export {
  extractSnsSubscribeConfirmation,
  isValidSnsHost,
  verifyGithub,
  verifySlack,
  verifySnsMessage,
  verifySourceToken,
  verifyStripe,
} from "./core/signature-verifiers.js";
export type {
  SnsCertFetch,
  SnsCertFetchResponse,
  SnsMessageFields,
  TimestampToleranceOptions,
} from "./core/signature-verifiers.js";
export {
  CIRCUIT_PAUSE_AFTER_CONSECUTIVE,
  RATE_LIMIT_WINDOW_MS,
  consumeTriggerEvent,
  runDueScheduleTriggers,
} from "./core/trigger-runner.js";
export type {
  CanStartRun,
  ConsumeTriggerEventDeps,
  CreateAndDispatchTriggerRun,
  TriggerEventInput,
  TriggerRunRequest,
  TriggerSweepError,
  TriggerSweepSummary,
} from "./core/trigger-runner.js";

// ---- Network egress (Phase C http_fetch) ---------------------------------
export {
  guardedHttpFetch,
  hostMatchesAllowlist,
  isBlockedIp,
  HttpFetchError,
} from "./core/http-fetch.js";
export type {
  DnsResolver,
  FetchFn,
  HttpFetchArgs,
  HttpFetchOptions,
  HttpFetchResult,
} from "./core/http-fetch.js";

// ---- Result delivery (Phase D) -------------------------------------------
export {
  buildWebhookPayload,
  deliverResult,
  signWebhookBody,
} from "./core/delivery.js";
export type {
  DeliverResultArgs,
  DeliverResultDeps,
  DeliveryResultInput,
  DeliveryWebhookPayload,
} from "./core/delivery.js";

// ---- User-provided inputs (Phase C) --------------------------------------
export {
  confineInputPath,
  INPUTS_SUBDIR,
  InputPathError,
  LocalInputStore,
} from "./core/input-store.js";

// ---- Sandbox executor (the hands) ---------------------------------------
export {
  makeSandboxExecutor,
  SANDBOX_FILE_TOOLS,
  SANDBOX_TOOLS,
} from "./core/sandbox-executor.js";
export type {
  MakeSandboxExecutorArgs,
  SandboxExecutor,
  SandboxToolName,
  SandboxToolResult,
  SandboxToolUse,
} from "./core/sandbox-executor.js";

// ---- Prompt-leakage guards (protected-kit content protection, M6) -------
// Generic redaction MECHANISM (no kit/prompt values) — wired in only on the
// hosted protected path; identity (no-op) everywhere else.
export {
  isPromptExtractionAttempt,
  redactLeakedPrompt,
  makePromptRedactor,
  identityRedactor,
} from "./core/leakage-guard.js";
export type { OutputRedactor } from "./core/leakage-guard.js";

// ---- Run driver ----------------------------------------------------------
export { runAutoRun, AUTO_NO_QUESTIONS_PREAMBLE, composeSystemPrompt } from "./core/run-driver.js";
export type {
  RunAutoRunArgs,
  RunAutoRunDeps,
  RunAutoRunResult,
} from "./core/run-driver.js";

// ---- Concurrency cap (L4 — per-user active-run limit) --------------------
export {
  ACTIVE_RUN_STATUSES,
  DEFAULT_MAX_CONCURRENT_RUNS,
  MAX_CONCURRENT_RUNS_ENV_VAR,
  checkConcurrency,
  countActiveRuns,
  isActiveRunStatus,
  resolveMaxConcurrentRuns,
} from "./core/concurrency.js";
export type { ConcurrencyVerdict } from "./core/concurrency.js";

// ---- Workspace (shared filesystem impl) ---------------------------------
export { FsWorkspaceStore, WorkspaceEscapeError } from "./core/fs-workspace.js";
export type { FsWorkspaceStoreOptions } from "./core/fs-workspace.js";

// ---- Deps factory --------------------------------------------------------
export { makeAutoDeps } from "./core/deps.js";
export type { AutoBackend, MakeAutoDepsOptions } from "./core/deps.js";

// ---- Worker entrypoint ---------------------------------------------------
export { processAutoRun, ApprovalDeniedError, HandledRunFailureError } from "./entrypoints/worker.js";
export type {
  ProcessAutoRunDeps,
  ResolveKitContext,
  ResolvedKitContext,
} from "./entrypoints/worker.js";

// ---- Auto v2 run-fee rate resolution (shared by worker + app) -----------
// The single source of truth for the v2 invocation + active-minute rates and the
// monthly free-minute allowance. The worker (run-task) and the app's in-process
// dispatcher BOTH resolve rates through this so the two paths bill identically;
// `enabled` is the managed-vs-free gate (free / open-core → 0/0/0, no fee).
export { loadAutoV2Rates } from "./entrypoints/run-task.js";
export type { AutoV2Rates } from "./entrypoints/run-task.js";

// ---- HTTP kit-context resolver (Fargate worker) -------------------------
export {
  fetchResolveContext,
  toResolveKitContext,
} from "./core/http-resolve-context.js";
export type {
  FetchResolveContextArgs,
  ResolveContextResponse,
} from "./core/http-resolve-context.js";

// ---- Persisted run outputs (worker harness, post-terminal) ---------------
export {
  RUN_OUTPUT_FILE_MAX_BYTES,
  RUN_OUTPUT_MAX_FILES,
  RUN_OUTPUT_TOTAL_MAX_BYTES,
  RUN_OUTPUT_TTL_MS,
  persistRunOutputs,
} from "./core/run-output-persist.js";
export type { PersistRunOutputsArgs } from "./core/run-output-persist.js";

// ---- Destination executor (worker harness — S2: secrets revealed only here)
export {
  DESTINATION_EMAIL_MAX_LINKS,
  DESTINATION_MAX_BODY_BYTES,
  DESTINATION_MAX_OUTPUT_CHARS,
  DESTINATION_WEBHOOK_TIMEOUT_MS,
  executeDestinations,
  parseS3ConnectionSecret,
} from "./core/destination-executor.js";
export type {
  DestinationExecutorDeps,
  DestinationOutcome,
  ExecuteDestinationsArgs,
  S3PutObjectFn,
} from "./core/destination-executor.js";

// ---- OAuth connection mechanism (gdrive/dropbox — BYO provider config) ----
export {
  OAUTH_ENV_VARS,
  OAUTH_PROVIDERS,
  OAUTH_PROVIDER_SETTINGS,
  OAuthExchangeError,
  buildOAuthAuthorizationUrl,
  ensureFreshOAuthToken,
  exchangeOAuthCode,
  isOAuthProvider,
  isOAuthTokenExpired,
  loadOAuthClientConfig,
  loadOAuthProvidersConfig,
  parseOAuthTokenSet,
  refreshOAuthToken,
  serializeOAuthTokenSet,
} from "./core/oauth-connections.js";
export type {
  OAuthClientConfig,
  OAuthProvider,
  OAuthProvidersConfig,
  OAuthTokenSet,
} from "./core/oauth-connections.js";

// ---- AWS adapter ---------------------------------------------------------
export {
  AUTO_EVENT_TABLE_DEFAULTS,
  AUTO_TABLE_ENV_VARS,
  awsClientEnv,
  createDynamoDBDocumentClient,
  DynamoAutoApprovalRepository,
  DynamoAutoRunRepository,
  DynamoAutoScheduleRepository,
  DynamoAutoWebhookRepository,
  DynamoConnectionRepository,
  DynamoEventSourceRepository,
  DynamoFireLogRepository,
  DynamoReceivedEventRepository,
  DynamoSecretStore,
  DynamoTriggerRepository,
  loadAutoDynamoTableNames,
  makeAwsAutoDeps,
  s3ClientEnv,
} from "./adapters/aws/index.js";
export type {
  AutoDynamoTableNames,
  MakeAwsAutoDepsOptions,
} from "./adapters/aws/index.js";
export { inputObjectKey, S3InputStore } from "./adapters/aws/s3-input-store.js";
export type { S3InputStoreOptions } from "./adapters/aws/s3-input-store.js";
export {
  OUTPUTS_KEY_PREFIX,
  OUTPUT_PRESIGN_TTL_SECONDS,
  OutputPathError,
  S3OutputStore,
  confineOutputPath,
  outputObjectKey,
} from "./adapters/aws/s3-output-store.js";
export type { PresignGetFn, S3OutputStoreOptions } from "./adapters/aws/s3-output-store.js";
export { makeSesEmailSender } from "./adapters/aws/ses-email-sender.js";
export type { SesEmailSenderOptions } from "./adapters/aws/ses-email-sender.js";

// ---- Self-host adapter ---------------------------------------------------
export {
  AUTO_SCHEMA_SQL,
  ensureAutoSchema,
  makeSelfHostAutoDeps,
  PostgresAutoApprovalRepository,
  PostgresAutoRunRepository,
  PostgresAutoScheduleRepository,
  PostgresAutoWebhookRepository,
  PostgresConnectionRepository,
  PostgresEventSourceRepository,
  PostgresFireLogRepository,
  PostgresReceivedEventRepository,
  PostgresSecretStore,
  PostgresTriggerRepository,
  makeSelfHostOutputStoreFromEnv,
} from "./adapters/selfhost/postgres.js";
export type {
  MakeSelfHostAutoDepsOptions,
  PgPool,
} from "./adapters/selfhost/postgres.js";
export { makeSelfHostEmailSender } from "./adapters/selfhost/email-sender.js";
export { makeFreeCreditLedger } from "./adapters/selfhost/free-ledger.js";
export {
  HttpLedgerClient,
  type HttpLedgerClientConfig,
  type AutoV2RatesResponse,
  type CanStartRunCheckRequest,
  type CanStartRunCheckResponse,
} from "./adapters/http/http-ledger-client.js";
