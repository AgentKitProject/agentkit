import { z } from "zod";

/**
 * AgentKitAuto seams — hosted autonomous Agent Kit runs.
 *
 * These contracts cross the Forge-desktop ↔ web-forge boundary (and the
 * web-forge ↔ worker boundary). They are the contracts-first promotion of the
 * shapes that previously lived locally in `@agentkitforge/auto-core`
 * (src/core/types.ts) and the web-forge Auto route handlers.
 *
 * Auth surfaces (four distinct paths — never conflated):
 *   Seam A (browser):  /api/auto/*          — AuthKit cookie session.
 *   Seam B (Forge):    /api/forge/auto/*    — WorkOS device-auth JWT (Bearer),
 *                       verified server-side via JWKS by requireForgeUser().
 *   Seam C (ingest):   /api/hooks/auto/{webhookId} — per-webhook shared secret
 *                       (header `x-auto-webhook-secret` or `?token=`).
 *   Seam D (internal): /api/internal/auto/* — service key
 *                       (header `x-service-key` or Bearer), server-only.
 *
 * SECRET HANDLING: a webhook is authenticated by a shared secret of which only a
 * sha256 hex HASH (`secretHash`) is ever stored. The plaintext is shown to the
 * user ONCE in the CREATE response (`secret`) and is NEVER present in any
 * list/get response schema. See `autoWebhookSchema` (no secret) vs
 * `createAutoWebhookResponseSchema` (one-time plaintext).
 */

// ---------------------------------------------------------------------------
// Status / trigger enums
// ---------------------------------------------------------------------------

export const autoRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "budget_exceeded"
]);
export type AutoRunStatus = z.infer<typeof autoRunStatusSchema>;

/** How a run was triggered. Defaults to "on_demand" for pre-Phase-B records. */
export const runTriggerSchema = z.enum(["on_demand", "schedule", "webhook"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/** How a run's model inference is billed. */
export const inferenceModeSchema = z.enum(["managed", "byo"]);
export type InferenceMode = z.infer<typeof inferenceModeSchema>;

/** Outcome of one recorded tool call in the run audit trail. */
export const auditOutcomeSchema = z.enum(["ok", "error", "rejected"]);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/** Phase A scope: a per-run ephemeral workspace the run may read + write. */
export const approvalScopeSchema = z.literal("workspace_read_write");
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

// ---------------------------------------------------------------------------
// Kit reference
// ---------------------------------------------------------------------------

/** Where a run's kit comes from (mirrors Bridge 5 provenance: market | local). */
export const kitRefSchema = z
  .object({
    source: z.enum(["market", "local"]),
    /** Market kit id (source === "market"). */
    marketKitId: z.string().min(1).optional(),
    /** Market slug, denormalised for display (source === "market"). */
    slug: z.string().min(1).optional(),
    /** Local kit id (source === "local"). */
    localKitId: z.string().min(1).optional()
  })
  .refine(
    (v) =>
      v.source === "market"
        ? typeof v.marketKitId === "string"
        : typeof v.localKitId === "string",
    { message: "kitRef must carry marketKitId (market) or localKitId (local)" }
  );
export type KitRef = z.infer<typeof kitRefSchema>;

// ---------------------------------------------------------------------------
// Network egress policy (deny_all | allowlist)
// ---------------------------------------------------------------------------

/**
 * Network egress policy for autonomous runs (Phase C).
 *   - `deny_all` (DEFAULT): no egress; the `http_fetch` sandbox tool is absent.
 *   - `allowlist`: egress only to the listed hosts (exact hostname or `*.suffix`
 *     wildcard-suffix), https-only and SSRF-guarded.
 */
export const networkPolicySchema = z.union([
  z.object({ mode: z.literal("deny_all") }),
  z.object({
    mode: z.literal("allowlist"),
    /** Exact hostnames or `*.suffix` wildcard-suffix patterns. */
    hosts: z.array(z.string().min(1))
  })
]);
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

/** The canonical deny-all policy (the default for every approval). */
export const DENY_ALL_NETWORK_POLICY: NetworkPolicy = { mode: "deny_all" };

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * A standing approval: the user's pre-authorization for autonomous runs of a
 * specific kit. The toolAllowlist is the consent surface.
 */
export const autoApprovalSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kitRef: kitRefSchema,
  scope: approvalScopeSchema,
  /** Tool names the user authorizes for autonomous use. */
  toolAllowlist: z.array(z.string().min(1)),
  /** Network egress policy. Defaults to `{ mode: "deny_all" }`. */
  networkPolicy: networkPolicySchema,
  /** Ceiling (US cents) a single run under this approval may budget. */
  maxBudgetCents: z.number().int().positive(),
  createdAt: z.string().min(1),
  /** Set when revoked; a revoked approval never permits a run. */
  revokedAt: z.string().min(1).nullable()
});
export type AutoApproval = z.infer<typeof autoApprovalSchema>;

/** Request body: POST /api/auto/approvals (and the Forge mirror). */
export const createAutoApprovalRequestSchema = z.object({
  kitRef: kitRefSchema,
  toolAllowlist: z.array(z.string().min(1)).optional(),
  maxBudgetCents: z.number().int().positive(),
  networkPolicy: networkPolicySchema.optional()
});
export type CreateAutoApprovalRequest = z.infer<typeof createAutoApprovalRequestSchema>;

/** Response body: GET /api/auto/approvals. */
export const listAutoApprovalsResponseSchema = z.object({
  approvals: z.array(autoApprovalSchema)
});
export type ListAutoApprovalsResponse = z.infer<typeof listAutoApprovalsResponseSchema>;

// ---------------------------------------------------------------------------
// Run input + result
// ---------------------------------------------------------------------------

/** A per-run input file the user supplies inline (seeded at workspace root). */
export const autoRunInputFileSchema = z.object({
  /** Workspace-relative path. */
  path: z.string().min(1),
  /** UTF-8 file contents. */
  content: z.string()
});
export type AutoRunInputFile = z.infer<typeof autoRunInputFileSchema>;

/**
 * A manifest entry for a per-run input file staged OUT-OF-BAND (Phase C).
 * References content staged in the InputStore; hydrated into `inputs/`.
 */
export const autoRunInputFileRefSchema = z.object({
  /** Workspace-relative path under `inputs/` (path-confined; no traversal). */
  path: z.string().min(1),
  /** Backing object key in the InputStore (e.g. an S3 key). Optional for local. */
  s3Key: z.string().min(1).optional()
});
export type AutoRunInputFileRef = z.infer<typeof autoRunInputFileRefSchema>;

export const autoRunInputSchema = z.object({
  /** User-provided per-run instruction string (the task). */
  prompt: z.string(),
  /** Optional inline files seeded into the workspace root before execution. */
  files: z.array(autoRunInputFileSchema).optional(),
  /** Optional structured trigger event (Phase C webhooks). */
  event: z.unknown().optional()
});
export type AutoRunInput = z.infer<typeof autoRunInputSchema>;

/** One file produced by the run, surfaced in the result manifest. */
export const workspaceFileEntrySchema = z.object({
  /** Workspace-relative path. */
  path: z.string().min(1),
  /** Byte size of the file. */
  sizeBytes: z.number().int().nonnegative()
});
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>;

/** Terminal result of a successful (or partially-progressed) run. */
export const autoRunResultSchema = z.object({
  /** Final assistant output text. */
  output: z.string(),
  /** Manifest of files present in the workspace at completion. */
  files: z.array(workspaceFileEntrySchema)
});
export type AutoRunResult = z.infer<typeof autoRunResultSchema>;

/** A single recorded tool call (the audit trail of what the agent did). */
export const auditEntrySchema = z.object({
  /** The tool invoked. */
  tool: z.string().min(1),
  /** A short, non-sensitive summary of the args (e.g. the path). */
  argsSummary: z.string(),
  outcome: auditOutcomeSchema,
  /** ISO 8601 timestamp. */
  ts: z.string().min(1),
  /** Optional short detail (error message / rejection reason). */
  detail: z.string().optional()
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The persisted record of one autonomous run. */
export const autoRunSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kitRef: kitRefSchema,
  status: autoRunStatusSchema,
  input: autoRunInputSchema,
  /** REQUIRED per-run budget in US cents. No default. */
  budgetCents: z.number().int().positive(),
  /** Cents debited so far (sum of per-turn settled debits). */
  spentCents: z.number().int().nonnegative(),
  /** Cents debited for INFERENCE only. 0 in BYO mode. Absent on legacy records. */
  spentInferenceCents: z.number().int().nonnegative().optional(),
  /** Cents debited for the per-minute cloud-run compute fee (BYO + cloud only). */
  spentComputeCents: z.number().int().nonnegative().optional(),
  /** How inference is billed. Defaults to "managed" for legacy records. */
  inferenceMode: inferenceModeSchema.optional(),
  /** True when the run executes on OUR hosted compute. */
  isCloudRun: z.boolean().optional(),
  /** Per-minute cloud-run compute fee (cents); only meaningful for BYO + cloud. */
  cloudRunCentsPerMin: z.number().int().nonnegative().optional(),
  /** Canonical model id (e.g. "claude-sonnet-4-6"). */
  model: z.string().min(1),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
  /** Final output + workspace manifest (set on success / partial completion). */
  result: autoRunResultSchema.optional(),
  /** Failure message (status === "failed"). */
  error: z.string().optional(),
  /** Append-only audit log of tool calls. */
  auditLog: z.array(auditEntrySchema),
  /** The ephemeral workspace backing this run (set when execution starts). */
  workspaceId: z.string().min(1).optional(),
  /** True when a kill-switch cancel was requested for this run. */
  cancelRequested: z.boolean().optional(),
  /** How this run was triggered. Defaults to "on_demand" when absent. */
  trigger: runTriggerSchema.optional(),
  /** The AutoSchedule that produced this run (iff trigger === "schedule"). */
  scheduleId: z.string().min(1).optional(),
  /** The AutoWebhook that produced this run (iff trigger === "webhook"). */
  webhookId: z.string().min(1).optional(),
  /** Out-of-band staged input-file manifest (Phase C). */
  inputFiles: z.array(autoRunInputFileRefSchema).optional()
});
export type AutoRun = z.infer<typeof autoRunSchema>;

/**
 * Request body: POST /api/auto/runs (and the Forge mirror). `input` may be a
 * full AutoRunInput, or a bare top-level `prompt` is accepted for convenience.
 */
export const createAutoRunRequestSchema = z.object({
  kitRef: kitRefSchema,
  input: autoRunInputSchema.optional(),
  /** Convenience: top-level prompt when `input` is omitted. */
  prompt: z.string().optional(),
  budgetCents: z.number().int().positive(),
  model: z.string().min(1).optional(),
  inferenceMode: inferenceModeSchema.optional(),
  inputFiles: z.array(autoRunInputFileRefSchema).optional()
});
export type CreateAutoRunRequest = z.infer<typeof createAutoRunRequestSchema>;

/** Compact acknowledgement returned when a run is created (or fired). */
export const autoRunAckSchema = z.object({
  id: z.string().min(1),
  status: autoRunStatusSchema,
  createdAt: z.string().min(1)
});
export type AutoRunAck = z.infer<typeof autoRunAckSchema>;

/** Response body: GET /api/auto/runs. */
export const listAutoRunsResponseSchema = z.object({
  runs: z.array(autoRunSchema)
});
export type ListAutoRunsResponse = z.infer<typeof listAutoRunsResponseSchema>;

/** Response body: POST /api/auto/runs/{id}/cancel. */
export const cancelAutoRunResponseSchema = z.object({
  ok: z.literal(true),
  canceling: z.literal(true)
});
export type CancelAutoRunResponse = z.infer<typeof cancelAutoRunResponseSchema>;

// ---------------------------------------------------------------------------
// Run input upload (out-of-band staging)
// ---------------------------------------------------------------------------

/** Request body: POST /api/auto/runs/inputs/upload-url. */
export const autoRunInputUploadRequestSchema = z.object({
  files: z.array(
    z.object({
      /** Workspace-relative path under `inputs/`. */
      path: z.string().min(1),
      contentType: z.string().min(1).optional()
    })
  )
});
export type AutoRunInputUploadRequest = z.infer<typeof autoRunInputUploadRequestSchema>;

/** Response body: POST /api/auto/runs/inputs/upload-url. */
export const autoRunInputUploadResponseSchema = z.object({
  stagingId: z.string().min(1),
  slots: z.array(
    z.object({
      path: z.string().min(1),
      s3Key: z.string().min(1),
      uploadUrl: z.string().url()
    })
  ),
  /** The manifest to pass back as `inputFiles` on the create-run request. */
  inputFiles: z.array(autoRunInputFileRefSchema)
});
export type AutoRunInputUploadResponse = z.infer<typeof autoRunInputUploadResponseSchema>;

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** A standing schedule: fires an autonomous run on a recurring cron cadence. */
export const autoScheduleSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kitRef: kitRefSchema,
  /** Standard 5-field cron expression (minute hour dom month dow). */
  cron: z.string().min(1),
  /** IANA timezone the cron is evaluated in. Defaults to "UTC". */
  timezone: z.string().min(1),
  /** The per-run task input (same shape Phase A runs use). */
  input: autoRunInputSchema,
  /** REQUIRED per-run budget in US cents. */
  budgetCents: z.number().int().positive(),
  /** Canonical model id for fired runs. */
  model: z.string().min(1),
  /** The standing AutoApproval id this schedule runs under (denormalised). */
  approvalId: z.string().min(1),
  /** Inference billing mode hint for fired runs. Defaults to "managed". */
  inferenceMode: inferenceModeSchema.optional(),
  /** Whether the schedule is active. Disabled schedules never fire. */
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** ISO of the last fire (null until first fire). */
  lastRunAt: z.string().min(1).nullable(),
  /** Run id produced by the last fire (null until first successful dispatch). */
  lastRunId: z.string().min(1).nullable(),
  /** Computed ISO of the NEXT scheduled fire (the due-selection key). */
  nextRunAt: z.string().min(1),
  /** Last fire error; null when the last fire was clean. */
  lastError: z.string().min(1).nullable()
});
export type AutoSchedule = z.infer<typeof autoScheduleSchema>;

/** Request body: POST /api/auto/schedules (and the Forge mirror). */
export const createAutoScheduleRequestSchema = z.object({
  kitRef: kitRefSchema,
  cron: z.string().min(1),
  timezone: z.string().min(1).optional(),
  input: autoRunInputSchema.optional(),
  /** Convenience: top-level prompt when `input` is omitted. */
  prompt: z.string().optional(),
  budgetCents: z.number().int().positive(),
  model: z.string().min(1).optional(),
  approvalId: z.string().min(1),
  inferenceMode: inferenceModeSchema.optional()
});
export type CreateAutoScheduleRequest = z.infer<typeof createAutoScheduleRequestSchema>;

/** Request body: PATCH /api/auto/schedules/{id}. All fields optional. */
export const updateAutoScheduleRequestSchema = z.object({
  cron: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  input: autoRunInputSchema.optional(),
  prompt: z.string().optional(),
  budgetCents: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
  inferenceMode: inferenceModeSchema.optional(),
  enabled: z.boolean().optional()
});
export type UpdateAutoScheduleRequest = z.infer<typeof updateAutoScheduleRequestSchema>;

/** Response body: GET /api/auto/schedules. */
export const listAutoSchedulesResponseSchema = z.object({
  schedules: z.array(autoScheduleSchema)
});
export type ListAutoSchedulesResponse = z.infer<typeof listAutoSchedulesResponseSchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * The PERSISTED webhook record (server-internal). Carries `secretHash` (sha256
 * hex of the shared secret) — the plaintext is NEVER stored. This schema must
 * NOT be used to shape any HTTP response; use `publicAutoWebhookSchema` or
 * `createAutoWebhookResponseSchema` instead.
 */
export const autoWebhookSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  kitRef: kitRefSchema,
  /** The standing AutoApproval id this webhook runs under (denormalised). */
  approvalId: z.string().min(1),
  /** REQUIRED per-fire budget in US cents. */
  budgetCents: z.number().int().positive(),
  /** Canonical model id for fired runs. */
  model: z.string().min(1),
  /** Inference billing mode hint for fired runs. Defaults to "managed". */
  inferenceMode: inferenceModeSchema.optional(),
  /** Whether the webhook is active. Disabled webhooks never fire. */
  enabled: z.boolean(),
  /** sha256 HEX hash of the shared secret. The plaintext is NEVER stored. */
  secretHash: z.string().min(1),
  createdAt: z.string().min(1),
  /** ISO of the last fire (null until first fire). */
  lastFiredAt: z.string().min(1).nullable(),
  /** Run id produced by the last fire (null until first successful dispatch). */
  lastRunId: z.string().min(1).nullable(),
  /** Last fire error; null when the last fire was clean. */
  lastError: z.string().min(1).nullable(),
  /** Number of times this webhook has fired (created a run). */
  fireCount: z.number().int().nonnegative()
});
export type AutoWebhook = z.infer<typeof autoWebhookSchema>;

/**
 * The PUBLIC webhook projection returned by list/get responses. It OMITS
 * `secretHash` (and never carries the plaintext `secret`) and adds the public
 * `ingestUrl` the user POSTs events to. This is the only webhook shape a
 * non-create response may use.
 */
export const publicAutoWebhookSchema = autoWebhookSchema
  .omit({ secretHash: true })
  .extend({
    /** Public fire endpoint: /api/hooks/auto/{id}. */
    ingestUrl: z.string().min(1)
  });
export type PublicAutoWebhook = z.infer<typeof publicAutoWebhookSchema>;

/** Request body: POST /api/auto/webhooks (and the Forge mirror). */
export const createAutoWebhookRequestSchema = z.object({
  kitRef: kitRefSchema,
  budgetCents: z.number().int().positive(),
  model: z.string().min(1).optional(),
  approvalId: z.string().min(1)
});
export type CreateAutoWebhookRequest = z.infer<typeof createAutoWebhookRequestSchema>;

/**
 * Response body: POST /api/auto/webhooks. This is the ONLY response that carries
 * the one-time plaintext `secret`; it is shown to the user once and can never be
 * retrieved again. `secretHash` is never present here.
 */
export const createAutoWebhookResponseSchema = publicAutoWebhookSchema.extend({
  /** One-time plaintext shared secret. Shown ONCE; never retrievable again. */
  secret: z.string().min(1)
});
export type CreateAutoWebhookResponse = z.infer<typeof createAutoWebhookResponseSchema>;

/** Request body: PATCH /api/auto/webhooks/{id} (enable/disable). */
export const updateAutoWebhookRequestSchema = z.object({
  enabled: z.boolean()
});
export type UpdateAutoWebhookRequest = z.infer<typeof updateAutoWebhookRequestSchema>;

/** Response body: GET /api/auto/webhooks. */
export const listAutoWebhooksResponseSchema = z.object({
  webhooks: z.array(publicAutoWebhookSchema)
});
export type ListAutoWebhooksResponse = z.infer<typeof listAutoWebhooksResponseSchema>;

/** Generic `{ ok: true }` acknowledgement (DELETE schedules/webhooks). */
export const autoOkResponseSchema = z.object({ ok: z.literal(true) });
export type AutoOkResponse = z.infer<typeof autoOkResponseSchema>;

// ---------------------------------------------------------------------------
// Internal worker seam (resolve-context, sweep)
// ---------------------------------------------------------------------------

/** Request body: POST /api/internal/auto/resolve-context. */
export const resolveContextRequestSchema = z.object({
  runId: z.string().min(1)
});
export type ResolveContextRequest = z.infer<typeof resolveContextRequestSchema>;

/**
 * Response body: POST /api/internal/auto/resolve-context. The resolved kit
 * execution context the worker needs to run. Lenient (passthrough): the worker
 * reads a stable subset; the resolver may add fields without a breaking change.
 */
export const resolveContextResponseSchema = z
  .object({
    /** Composed system prompt for the run. */
    systemPrompt: z.string(),
    /** Tool definitions available to the run (provider tool schema; opaque here). */
    tools: z.array(z.unknown()),
    /** Convenience list of tool names (intersection of consent + kit + sandbox). */
    toolNames: z.array(z.string())
  })
  .passthrough();
export type ResolveContextResponse = z.infer<typeof resolveContextResponseSchema>;

/** Response body: POST /api/internal/auto/sweep (schedule sweep summary). */
export const scheduleSweepSummarySchema = z.object({
  processed: z.number().int().nonnegative(),
  dispatched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      scheduleId: z.string().min(1),
      error: z.string()
    })
  )
});
export type ScheduleSweepSummary = z.infer<typeof scheduleSweepSummarySchema>;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * The complete set of machine-readable error codes returned across the Auto
 * surface (in a `{ error: <code> }` body). `insufficient_balance` responses
 * also carry a `requiredCents` number.
 */
export const autoErrorCodeSchema = z.enum([
  /** Request body failed validation. (400) */
  "invalid_request",
  /** No matching/non-revoked approval, or budget over the approval ceiling. (403) */
  "approval_denied",
  /** BYO + cloud run lacks prepaid balance for the compute fee. (402) */
  "insufficient_balance",
  /** Resource not found or ownership mismatch. (404) */
  "not_found",
  /** Out-of-band input staging (S3 inputs bucket) is not configured. (503) */
  "inputs_unconfigured",
  /** Webhook ingest secret / internal service key missing or wrong. (401) */
  "unauthorized",
  /** Internal worker service key (AUTO_WORKER_SERVICE_KEY) not configured. (503) */
  "internal_auth_unconfigured"
]);
export type AutoErrorCode = z.infer<typeof autoErrorCodeSchema>;

/** Standard Auto error envelope. */
export const autoErrorResponseSchema = z.object({
  error: autoErrorCodeSchema,
  /** Present on `insufficient_balance`: cents the caller must top up to. */
  requiredCents: z.number().int().nonnegative().optional(),
  /** Optional human-readable detail. */
  message: z.string().optional()
});
export type AutoErrorResponse = z.infer<typeof autoErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

/** Seam C: per-webhook shared secret header for inbound ingest fires. */
export const autoWebhookSecretHeader = "x-auto-webhook-secret" as const;

/** Seam D: internal worker service-key header (server-only). */
export const autoInternalServiceKeyHeader = "x-service-key" as const;

// ---------------------------------------------------------------------------
// Route builders
// ---------------------------------------------------------------------------

/** Seam A — browser routes (/api/auto/*, AuthKit cookie). */
export const autoRoutes = {
  approvals: () => "/api/auto/approvals",
  revokeApproval: (id: string) => `/api/auto/approvals/${encodeURIComponent(id)}/revoke`,
  runs: () => "/api/auto/runs",
  run: (id: string) => `/api/auto/runs/${encodeURIComponent(id)}`,
  cancelRun: (id: string) => `/api/auto/runs/${encodeURIComponent(id)}/cancel`,
  runInputsUploadUrl: () => "/api/auto/runs/inputs/upload-url",
  schedules: () => "/api/auto/schedules",
  schedule: (id: string) => `/api/auto/schedules/${encodeURIComponent(id)}`,
  webhooks: () => "/api/auto/webhooks",
  webhook: (id: string) => `/api/auto/webhooks/${encodeURIComponent(id)}`,
  /** BYO Anthropic key + inference-mode preference (cookie path). GET status,
   *  PUT set/update, DELETE clear. */
  byoKey: () => "/api/auto/byo-key"
} as const;

/** Seam B — Forge device-auth routes (/api/forge/auto/*, Bearer JWT). */
export const forgeAutoRoutes = {
  approvals: () => "/api/forge/auto/approvals",
  revokeApproval: (id: string) =>
    `/api/forge/auto/approvals/${encodeURIComponent(id)}/revoke`,
  runs: () => "/api/forge/auto/runs",
  run: (id: string) => `/api/forge/auto/runs/${encodeURIComponent(id)}`,
  cancelRun: (id: string) => `/api/forge/auto/runs/${encodeURIComponent(id)}/cancel`,
  runInputsUploadUrl: () => "/api/forge/auto/runs/inputs/upload-url",
  schedules: () => "/api/forge/auto/schedules",
  schedule: (id: string) => `/api/forge/auto/schedules/${encodeURIComponent(id)}`,
  webhooks: () => "/api/forge/auto/webhooks",
  webhook: (id: string) => `/api/forge/auto/webhooks/${encodeURIComponent(id)}`
} as const;

/** Seam C — public webhook ingest (per-webhook shared secret). */
export const autoHookRoutes = {
  ingest: (webhookId: string) => `/api/hooks/auto/${encodeURIComponent(webhookId)}`
} as const;

/** Seam D — internal worker routes (service-key, server-only). */
export const autoInternalRoutes = {
  resolveContext: () => "/api/internal/auto/resolve-context",
  sweep: () => "/api/internal/auto/sweep"
} as const;
