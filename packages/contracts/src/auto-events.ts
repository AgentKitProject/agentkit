import { z } from "zod";
import { inferenceModeSchema, kitRefSchema, type InferenceMode } from "./auto.js";

/**
 * AgentKitAuto event-driven seams — the unified Trigger model.
 *
 * These contracts are the foundation of the event-driven expansion: user-created
 * ingest endpoints (EventSource, IFTTT-maker-event pattern), a received-event
 * inspector ring buffer (ReceivedEvent), the unified automation record (Trigger,
 * superseding the separate AutoSchedule/AutoWebhook records), output
 * destinations, non-secret Connections, and the fire log.
 *
 * INVARIANTS (load-bearing — evaluators/harnesses enforce them; the contracts
 * carry the shapes):
 *   S1 — events are DATA, never instructions. The ONLY instruction source for a
 *        trigger-fired run is `TriggerMapping.promptTemplate`. Event payloads are
 *        interpolated as values / attached as files — never concatenated into the
 *        prompt as free text.
 *   S2 — the contracts NEVER carry secrets. EventSource stores only `tokenHash`
 *        (sha256 hex of OUR bearer token, mirroring the webhook `secretHash`
 *        pattern); provider HMAC signing secrets are stored encrypted-recoverable
 *        elsewhere (verifiers need plaintext for HMAC) and the contract carries
 *        only `hasSigningSecret`. Connections carry an opaque `secretRef` handle
 *        into an encrypted secret store — `config` is refined to REJECT
 *        secret-looking keys.
 *
 * Auth surfaces (extends the seams documented in ./auto.ts):
 *   Seam A (browser):  /api/auto/triggers|event-sources|connections — OIDC cookie.
 *   Seam C (ingest):   /api/hooks/auto/events/{sourceId}/{eventName} — per-source
 *                      bearer token (`Authorization: Bearer <token>`, verified
 *                      against `tokenHash`).
 */

// ---------------------------------------------------------------------------
// Limits (exported consts)
// ---------------------------------------------------------------------------

/** Maximum accepted ingest payload size in bytes (callers enforce; the schema
 *  carries `payload` as `unknown`). */
export const EVENT_PAYLOAD_MAX_BYTES = 65536;

/** Maximum characters a single `{{path.to.field}}` interpolation may expand to
 *  (the evaluator truncates beyond this — S1: payloads stay data-sized). */
export const MAPPING_FIELD_INTERPOLATION_MAX_CHARS = 2000;

/** Maximum characters of the fully-interpolated prompt (evaluator-enforced). */
export const MAPPING_TOTAL_PROMPT_MAX_CHARS = 8000;

/** Inference modes for which `canStartRun` failures FAIL CLOSED (a ledger
 *  outage must never start an unbillable managed run; BYO may proceed). */
export const CAN_START_FAIL_CLOSED_MODES: readonly InferenceMode[] = ["managed"];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** An https-only URL (destinations/feeds never use plain http). */
const httpsUrlSchema = z
  .string()
  .url()
  .refine((v) => v.startsWith("https://"), { message: "url must be https" });

/**
 * The free-form event name carried in the ingest URL path (IFTTT maker-event
 * pattern). Path-safe by construction: dots/dashes/underscores only.
 */
export const eventNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/, "event name must match ^[a-zA-Z0-9._-]+$");
export type EventName = z.infer<typeof eventNameSchema>;

/** A run status that is TERMINAL (run_completed triggers subscribe to these). */
export const runTerminalStatusSchema = z.enum([
  "succeeded",
  "failed",
  "canceled",
  "budget_exceeded"
]);
export type RunTerminalStatus = z.infer<typeof runTerminalStatusSchema>;

// ---------------------------------------------------------------------------
// Event sources (user-created ingest endpoints)
// ---------------------------------------------------------------------------

/** "custom" = user-invented events (curl/IFTTT-style); "provider" = a known
 *  third-party webhook shape (payload verification/normalization applies). */
export const eventSourceKindSchema = z.enum(["custom", "provider"]);
export type EventSourceKind = z.infer<typeof eventSourceKindSchema>;

/** Known provider payload shapes for kind === "provider". */
export const eventSourceProviderSchema = z.enum([
  "generic",
  "github",
  "stripe",
  "sns",
  "slack"
]);
export type EventSourceProvider = z.infer<typeof eventSourceProviderSchema>;

/**
 * The PERSISTED event-source record (server-internal). Carries `tokenHash`
 * (sha256 hex of OUR ingest bearer token — the plaintext is NEVER stored,
 * mirroring the webhook `secretHash` pattern). This schema must NOT shape any
 * HTTP response; use `publicEventSourceSchema` or
 * `createEventSourceResponseSchema` instead.
 *
 * Provider HMAC signing secrets (github/stripe/slack signature verification)
 * are NOT carried here in any form: verifiers need the plaintext for HMAC, so
 * they live ENCRYPTED-RECOVERABLE in the secret store — the contract only
 * carries the `hasSigningSecret` boolean.
 */
export const eventSourceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: eventSourceKindSchema,
  /** Payload shape hint (kind === "provider"). */
  provider: eventSourceProviderSchema.optional(),
  /** sha256 HEX hash of OUR ingest bearer token. Plaintext is NEVER stored. */
  tokenHash: z.string().min(1),
  /** True when a provider HMAC signing secret is configured (stored encrypted
   *  elsewhere — never in this contract). */
  hasSigningSecret: z.boolean(),
  /** Whether the source accepts events. Disabled sources reject ingest. */
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  /** ISO of the last accepted event (absent until first event). */
  lastEventAt: z.string().min(1).optional(),
  /** Number of events accepted on this source. */
  eventCount: z.number().int().nonnegative().default(0)
});
export type EventSource = z.infer<typeof eventSourceSchema>;

/**
 * The PUBLIC event-source projection returned by list/get responses. It OMITS
 * `tokenHash` (and never carries the plaintext `token`) and adds the public
 * `ingestUrl` events are POSTed to (event name appended per fire).
 */
export const publicEventSourceSchema = eventSourceSchema
  .omit({ tokenHash: true })
  .extend({
    /** Public ingest endpoint base: /api/hooks/auto/events/{id}/{eventName}. */
    ingestUrl: z.string().min(1)
  });
export type PublicEventSource = z.infer<typeof publicEventSourceSchema>;

/** Request body: POST /api/auto/event-sources. */
export const createEventSourceRequestSchema = z.object({
  name: z.string().min(1).max(80),
  /** Defaults to "custom". */
  kind: eventSourceKindSchema.default("custom"),
  provider: eventSourceProviderSchema.optional(),
  /**
   * WRITE-ONLY provider signing secret (e.g. the GitHub webhook secret) used to
   * verify inbound signatures. Stored encrypted-recoverable server-side (S2:
   * worker/server-only — verifiers need the plaintext for HMAC, unlike our own
   * bearer token which is only ever hashed). Never echoed in any response;
   * presence is reflected as `hasSigningSecret`.
   */
  signingSecret: z.string().min(1).max(500).optional()
});
export type CreateEventSourceRequest = z.infer<typeof createEventSourceRequestSchema>;

/**
 * Response body: POST /api/auto/event-sources. This is the ONLY response that
 * carries the one-time plaintext bearer `token`; it is shown to the user once
 * and can never be retrieved again (mirrors createAutoWebhookResponseSchema).
 */
export const createEventSourceResponseSchema = publicEventSourceSchema.extend({
  /** One-time plaintext ingest bearer token. Shown ONCE; never retrievable. */
  token: z.string().min(1)
});
export type CreateEventSourceResponse = z.infer<typeof createEventSourceResponseSchema>;

/** Request body: PATCH /api/auto/event-sources/{id}. */
export const updateEventSourceRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  /** WRITE-ONLY: set/replace the provider signing secret (see create). Never echoed. */
  signingSecret: z.string().min(1).max(500).optional()
});
export type UpdateEventSourceRequest = z.infer<typeof updateEventSourceRequestSchema>;

/** Response body: GET /api/auto/event-sources. */
export const listEventSourcesResponseSchema = z.object({
  sources: z.array(publicEventSourceSchema)
});
export type ListEventSourcesResponse = z.infer<typeof listEventSourcesResponseSchema>;

// ---------------------------------------------------------------------------
// Received events (inspector ring buffer)
// ---------------------------------------------------------------------------

/** Outcome of one trigger-fire attempt (the fire log + delivery summaries). */
export const triggerFireOutcomeSchema = z.enum([
  /** A run was created. */
  "run_created",
  /** Filters did not match — intentionally skipped. */
  "filtered",
  /** Rate limit (maxPerHour) suppressed the fire. */
  "suppressed_rate",
  /** Affordability pre-check said no (canStartRun → not allowed). */
  "skipped_funds",
  /** Circuit breaker is paused (consecutive failures). */
  "suppressed_circuit",
  /** The fire attempt errored. */
  "error"
]);
export type TriggerFireOutcome = z.infer<typeof triggerFireOutcomeSchema>;

/** Per-trigger delivery summary stamped onto a received event. */
export const receivedEventDeliverySchema = z.object({
  triggerId: z.string().min(1),
  outcome: triggerFireOutcomeSchema
});
export type ReceivedEventDelivery = z.infer<typeof receivedEventDeliverySchema>;

/**
 * One inspector ring-buffer entry: an event accepted on an EventSource. The
 * buffer is capped per source + TTL'd (repository semantics); `payload` is
 * `unknown` here — callers enforce EVENT_PAYLOAD_MAX_BYTES at ingest.
 */
export const receivedEventSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  /** The free-form eventName from the ingest URL path. */
  name: eventNameSchema,
  receivedAt: z.string().min(1),
  /** The event payload (data, never instructions — S1). ≤ EVENT_PAYLOAD_MAX_BYTES. */
  payload: z.unknown(),
  /** Which triggers saw this event, and with what outcome. */
  delivered: z.array(receivedEventDeliverySchema).optional()
});
export type ReceivedEvent = z.infer<typeof receivedEventSchema>;

/** Response body: GET /api/auto/event-sources/{id}/events. */
export const listReceivedEventsResponseSchema = z.object({
  events: z.array(receivedEventSchema)
});
export type ListReceivedEventsResponse = z.infer<typeof listReceivedEventsResponseSchema>;

/**
 * Response body: POST /api/hooks/auto/events/{sourceId}/{eventName} (ingest).
 * `suppressed` = accepted but intentionally not fanned out (e.g. source-level
 * throttling); `eventId` is set when the event entered the ring buffer.
 */
export const emitEventResponseSchema = z.object({
  accepted: z.boolean(),
  eventId: z.string().min(1).optional(),
  suppressed: z.boolean().optional()
});
export type EmitEventResponse = z.infer<typeof emitEventResponseSchema>;

/** Request body: POST /api/auto/event-sources/{id}/replay (re-fan-out an event). */
export const replayEventRequestSchema = z.object({
  eventId: z.string().min(1)
});
export type ReplayEventRequest = z.infer<typeof replayEventRequestSchema>;

// ---------------------------------------------------------------------------
// Trigger mapping (S1: events are data, never instructions)
// ---------------------------------------------------------------------------

/**
 * How an event becomes a run input. S1 INVARIANT: `promptTemplate` is the ONLY
 * instruction source — REQUIRED, authored by the trigger owner at create time.
 * `{{path.to.field}}` placeholders interpolate event VALUES (each expansion
 * capped at MAPPING_FIELD_INTERPOLATION_MAX_CHARS; the final prompt capped at
 * MAPPING_TOTAL_PROMPT_MAX_CHARS). The raw payload is attached as a FILE
 * (`attachPayloadAs`), never concatenated into the prompt.
 */
export const triggerMappingSchema = z.object({
  /** The ONLY instruction source for fired runs. Supports {{path.to.field}}. */
  promptTemplate: z.string().min(1).max(4000),
  /** Workspace filename the raw payload is attached as; null = don't attach. */
  attachPayloadAs: z.string().min(1).nullable().default("event.json"),
  /** Event-carried files → run input files ("attach") or dropped ("ignore"). */
  fileHandling: z.enum(["attach", "ignore"]).default("attach")
});
export type TriggerMapping = z.infer<typeof triggerMappingSchema>;

// ---------------------------------------------------------------------------
// Trigger filters (declarative — NO code)
// ---------------------------------------------------------------------------

/** Filter comparison operators. `matches` carries a LITERAL-SAFE (RE2-safe
 *  subset) pattern — the evaluator enforces safety; the contract just carries. */
export const triggerFilterOpSchema = z.enum([
  "eq",
  "ne",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
  "exists",
  "matches"
]);
export type TriggerFilterOp = z.infer<typeof triggerFilterOpSchema>;

/**
 * One declarative payload filter: `path` is a dot/bracket path into the event
 * payload (data addressing only — NO code, NO expressions). A trigger carries
 * at most 10 filters; ALL must pass for the trigger to fire.
 */
export const triggerFilterSchema = z.object({
  /** Dot/bracket path into the payload (e.g. "action", "issue.labels[0]"). */
  path: z.string().min(1).max(200),
  op: triggerFilterOpSchema,
  /** Comparison operand (absent for "exists"). */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()
});
export type TriggerFilter = z.infer<typeof triggerFilterSchema>;

// ---------------------------------------------------------------------------
// Destinations (max 5 per trigger — supersedes deliveryConfig)
// ---------------------------------------------------------------------------

/**
 * Where a fired run's output goes. Discriminated by `type`; a trigger carries
 * at most 5. Supersedes the legacy per-record `deliveryConfig` (email+webhook
 * only) — deliveryConfig stays for back-compat, new work uses destinations[].
 */
export const destinationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    /** Recipient addresses (basic-format validated). */
    to: z.array(z.string().email()).min(1).max(5)
  }),
  z.object({
    type: z.literal("webhook_out"),
    /** Destination URL. MUST be https (SSRF-guarded at delivery time). */
    url: httpsUrlSchema,
    /** Optional HMAC-SHA256 signing secret (mirrors deliveryConfig.webhook). */
    secret: z.string().min(1).nullable().optional()
  }),
  z.object({
    type: z.literal("slack_incoming"),
    /** A Slack incoming-webhook URL (https; hooks.slack.com host). */
    url: httpsUrlSchema
  }),
  z.object({
    type: z.literal("connection"),
    /** The Connection files/summaries are delivered through. */
    connectionId: z.string().min(1),
    /** Prefix/folder for file outputs within the connection target. */
    path: z.string().optional(),
    /** What to deliver: output files, the run summary, or both. */
    what: z.enum(["outputs", "summary", "both"]).default("both")
  })
]);
export type Destination = z.infer<typeof destinationSchema>;

// ---------------------------------------------------------------------------
// Connections (non-secret config + opaque secretRef — S2)
// ---------------------------------------------------------------------------

export const connectionOwnerTypeSchema = z.enum(["user", "org"]);
export type ConnectionOwnerType = z.infer<typeof connectionOwnerTypeSchema>;

export const connectionTypeSchema = z.enum([
  "s3",
  "email",
  "webhook_out",
  "slack_incoming",
  "gdrive",
  "dropbox",
  "imap"
]);
export type ConnectionType = z.infer<typeof connectionTypeSchema>;

export const connectionStatusSchema = z.enum(["ok", "error", "unverified"]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** Key names (case/word-separator-insensitive) that must NEVER appear in a
 *  connection `config` — secret material goes through the SecretStore only. */
const FORBIDDEN_CONFIG_KEY_NAMES = new Set(["secret", "password", "token", "apikey"]);

/** Depth-first search for a secret-looking key anywhere inside `config`. */
function findForbiddenConfigKey(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONFIG_KEY_NAMES.has(key.toLowerCase().replace(/[_-]/g, ""))) {
      return key;
    }
    const nested = findForbiddenConfigKey(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * NON-SECRET connection configuration: endpoint/bucket/region/prefix/from/url/
 * username as applicable per type. Intentionally a loose record (each type
 * reads its own subset), but REFINED to reject secret-looking keys
 * (secret/password/token/apiKey, any casing/word separator, at any depth) —
 * secrets travel ONLY as an opaque `secretRef` into the encrypted secret store.
 */
export const connectionConfigSchema = z.record(z.unknown()).superRefine((cfg, ctx) => {
  const bad = findForbiddenConfigKey(cfg);
  if (bad !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `config must not carry secret material (found key "${bad}") — store secrets via secretRef`
    });
  }
});
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

/**
 * A reusable delivery/ingest connection (S3 bucket, SMTP sender, outbound
 * webhook, Slack incoming webhook, Drive/Dropbox folder, IMAP inbox). The
 * contract NEVER carries secrets: `secretRef` is an opaque handle into an
 * encrypted secret store (worker/server-only — S2).
 */
export const connectionSchema = z
  .object({
    id: z.string().min(1),
    ownerType: connectionOwnerTypeSchema,
    ownerId: z.string().min(1),
    name: z.string().min(1).max(80),
    type: connectionTypeSchema,
    config: connectionConfigSchema,
    /** Opaque handle into the encrypted secret store; null = no secret needed. */
    secretRef: z.string().min(1).nullable().optional(),
    /** Verification state. Defaults to "unverified" until a probe succeeds. */
    status: connectionStatusSchema.default("unverified"),
    lastUsedAt: z.string().min(1).optional(),
    createdAt: z.string().min(1)
  })
  .superRefine((conn, ctx) => {
    // Cheap per-type checks: URL-bearing types must carry an https url when present.
    if (conn.type === "webhook_out" || conn.type === "slack_incoming") {
      const url = (conn.config as Record<string, unknown>).url;
      if (url !== undefined && (typeof url !== "string" || !url.startsWith("https://"))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `config.url must be an https URL for type "${conn.type}"`
        });
      }
    }
  });
export type Connection = z.infer<typeof connectionSchema>;

/**
 * Request body: POST /api/auto/connections. `secret` is WRITE-ONLY inbound
 * credential material: the server moves it straight into the SecretStore
 * (→ `secretRef`) and it is NEVER echoed in any response or persisted record.
 */
export const createConnectionRequestSchema = z.object({
  name: z.string().min(1).max(80),
  type: connectionTypeSchema,
  config: connectionConfigSchema,
  /** Write-only plaintext credential; stored encrypted, never echoed. */
  secret: z.string().min(1).optional(),
  /** Defaults to "user" (the session user). */
  ownerType: connectionOwnerTypeSchema.default("user"),
  /** Owning org id (required server-side when ownerType === "org"). */
  orgId: z.string().min(1).optional()
});
export type CreateConnectionRequest = z.infer<typeof createConnectionRequestSchema>;

/** Request body: PATCH /api/auto/connections/{id}. `secret` rotates the stored
 *  credential (write-only, same handling as create). */
export const updateConnectionRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  config: connectionConfigSchema.optional(),
  secret: z.string().min(1).optional()
});
export type UpdateConnectionRequest = z.infer<typeof updateConnectionRequestSchema>;

/** Response body: GET /api/auto/connections. */
export const listConnectionsResponseSchema = z.object({
  connections: z.array(connectionSchema)
});
export type ListConnectionsResponse = z.infer<typeof listConnectionsResponseSchema>;

// ---------------------------------------------------------------------------
// Triggers (THE unified automation record)
// ---------------------------------------------------------------------------

/** The trigger kinds. "message" is P5: schema now, implementation later. */
export const triggerTypeSchema = z.enum([
  "schedule",
  "event",
  "watch",
  "rss",
  "run_completed",
  "email_in",
  "message"
]);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

/** Per-trigger fire rate limit (abuse/cost guard). */
export const triggerRateLimitSchema = z.object({
  /** Maximum fires per rolling hour. */
  maxPerHour: z.number().int().min(1).max(500).default(20)
});
export type TriggerRateLimit = z.infer<typeof triggerRateLimitSchema>;

/** Circuit-breaker state: consecutive fire failures pause the trigger. */
export const triggerCircuitSchema = z.object({
  consecutiveFailures: z.number().int().nonnegative().default(0),
  /** ISO of when the breaker paused the trigger; null/absent = not paused. */
  pausedAt: z.string().min(1).nullable().optional()
});
export type TriggerCircuit = z.infer<typeof triggerCircuitSchema>;

/** config for type "schedule" (reuses AutoSchedule cron semantics). */
export const scheduleTriggerConfigSchema = z.object({
  /** Standard 5-field cron expression (minute hour dom month dow). */
  cron: z.string().min(1),
  /** IANA timezone the cron is evaluated in. Defaults to "UTC". */
  timezone: z.string().min(1).optional()
});
export type ScheduleTriggerConfig = z.infer<typeof scheduleTriggerConfigSchema>;

/** config for type "event" (fires on EventSource ingest). */
export const eventTriggerConfigSchema = z.object({
  sourceId: z.string().min(1),
  /** Event name to subscribe to; null/absent = ALL names on the source. */
  eventName: eventNameSchema.nullable().optional()
});
export type EventTriggerConfig = z.infer<typeof eventTriggerConfigSchema>;

/** config for type "watch" (poll a Connection for new/changed files). */
export const watchTriggerConfigSchema = z.object({
  connectionId: z.string().min(1),
  /** Path prefix to watch within the connection target. */
  prefix: z.string().default(""),
  /** Optional filename pattern (literal-safe, like filter "matches"). */
  pattern: z.string().min(1).nullable().optional(),
  /** One run per new file, or one run per detected batch. */
  batchMode: z.enum(["per_file", "per_batch"]).default("per_file"),
  /** Poll cadence in minutes (the sweep skips the trigger until due). */
  intervalMinutes: z.number().int().min(1).max(1440).default(5),
  /**
   * First-sweep behavior: false (default) = the first sweep only BASELINES the
   * watched prefix (no event storm on a pre-populated bucket); true = existing
   * objects fire as new (still subject to the per-sweep cap).
   */
  includeExisting: z.boolean().default(false)
});
export type WatchTriggerConfig = z.infer<typeof watchTriggerConfigSchema>;

/** config for type "rss" (poll a feed for new entries). */
export const rssTriggerConfigSchema = z.object({
  feedUrl: httpsUrlSchema,
  /** Poll cadence in minutes (feeds are polled gently: minimum 5). */
  intervalMinutes: z.number().int().min(5).max(1440).default(15)
});
export type RssTriggerConfig = z.infer<typeof rssTriggerConfigSchema>;

/** config for type "run_completed" (kit-chaining: fire when a run finishes). */
export const runCompletedTriggerConfigSchema = z.object({
  /** Only chain off runs fired by this trigger; null/absent = any trigger. */
  sourceTriggerId: z.string().min(1).nullable().optional(),
  /** Only chain off runs of this kit; null/absent = any kit. */
  kitRef: kitRefSchema.nullable().optional(),
  /** Terminal statuses that fire the chain. Defaults to ["succeeded"]. */
  statuses: z.array(runTerminalStatusSchema).default(["succeeded"])
});
export type RunCompletedTriggerConfig = z.infer<typeof runCompletedTriggerConfigSchema>;

/** config for type "email_in" (inbound email fires the trigger). */
export const emailInTriggerConfigSchema = z.object({
  /** The inbound address (assigned server-side on hosted). */
  address: z.string().min(1).nullable().optional(),
  /** IMAP Connection to poll (self-host path). */
  connectionId: z.string().min(1).nullable().optional()
});
export type EmailInTriggerConfig = z.infer<typeof emailInTriggerConfigSchema>;

/** config for type "message" (P5 — chat mention/DM/channel; schema only). */
export const messageTriggerConfigSchema = z.object({
  connectionId: z.string().min(1),
  scope: z.enum(["mention", "dm", "channel"]),
  channelId: z.string().min(1).nullable().optional()
});
export type MessageTriggerConfig = z.infer<typeof messageTriggerConfigSchema>;

/**
 * Fields shared by every trigger variant. Like schedules/webhooks, a trigger
 * does NOT widen consent: every fire is still gated by the referenced standing
 * approval and the run budget, PLUS the trigger-level rate limit, the
 * affordability pre-check (canStartRun), and the circuit breaker.
 */
const triggerBaseShape = {
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1).max(80),
  kitRef: kitRefSchema,
  /** The standing AutoApproval id fires run under (denormalised). */
  approvalId: z.string().min(1),
  /** Canonical model id for fired runs (server default when absent). */
  model: z.string().min(1).optional(),
  /** Per-fire run budget in US cents (server default when absent). */
  budgetCents: z.number().int().nonnegative().optional(),
  /** Declarative payload filters (ALL must pass). Max 10. */
  filters: z.array(triggerFilterSchema).max(10).optional(),
  /** S1: the only instruction source for fired runs. */
  mapping: triggerMappingSchema,
  /** Output destinations (max 5). Supersedes legacy deliveryConfig. */
  destinations: z.array(destinationSchema).max(5).optional(),
  rateLimit: triggerRateLimitSchema.default({}),
  /** Whether the trigger is active. Disabled triggers never fire. */
  enabled: z.boolean(),
  /** Poll resume point (watch/rss/run_completed; schedule stores next-fire ISO). */
  cursor: z.string().nullable().optional(),
  circuit: triggerCircuitSchema.default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** ISO of the last fire (absent until first fire). */
  lastFiredAt: z.string().min(1).optional(),
  /** Run id produced by the last fire. */
  lastRunId: z.string().min(1).optional(),
  /** Last fire error (absent when the last fire was clean). */
  lastError: z.string().min(1).optional(),
  /** Number of times this trigger has fired (created a run). */
  fireCount: z.number().int().nonnegative().default(0)
} as const;

/**
 * THE unified automation record: one trigger = one (source of fires) ×
 * (kit to run) × (mapping) × (destinations). Discriminated on `type`; the
 * per-type `config` carries the source-specific settings. Supersedes the
 * separate AutoSchedule (type "schedule") and AutoWebhook (type "event" +
 * EventSource) records — which remain supported for back-compat.
 */
export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ ...triggerBaseShape, type: z.literal("schedule"), config: scheduleTriggerConfigSchema }),
  z.object({ ...triggerBaseShape, type: z.literal("event"), config: eventTriggerConfigSchema }),
  z.object({ ...triggerBaseShape, type: z.literal("watch"), config: watchTriggerConfigSchema }),
  z.object({ ...triggerBaseShape, type: z.literal("rss"), config: rssTriggerConfigSchema }),
  z.object({ ...triggerBaseShape, type: z.literal("run_completed"), config: runCompletedTriggerConfigSchema }),
  z.object({ ...triggerBaseShape, type: z.literal("email_in"), config: emailInTriggerConfigSchema }),
  z.object({ ...triggerBaseShape, type: z.literal("message"), config: messageTriggerConfigSchema })
]);
export type Trigger = z.infer<typeof triggerSchema>;

/** The union of all per-type trigger configs. */
export type TriggerConfig = Trigger["config"];

// ---------------------------------------------------------------------------
// Trigger CRUD (create/list/patch — delete reuses autoOkResponseSchema)
// ---------------------------------------------------------------------------

/** Fields a create-trigger request carries (server owns id/timestamps/state). */
const createTriggerBaseShape = {
  name: z.string().min(1).max(80),
  kitRef: kitRefSchema,
  approvalId: z.string().min(1),
  model: z.string().min(1).optional(),
  budgetCents: z.number().int().nonnegative().optional(),
  filters: z.array(triggerFilterSchema).max(10).optional(),
  mapping: triggerMappingSchema,
  destinations: z.array(destinationSchema).max(5).optional(),
  rateLimit: triggerRateLimitSchema.optional(),
  /** Defaults to true (enabled) when omitted. */
  enabled: z.boolean().optional()
} as const;

/** Request body: POST /api/auto/triggers. Discriminated on `type` like the record. */
export const createTriggerRequestSchema = z.discriminatedUnion("type", [
  z.object({ ...createTriggerBaseShape, type: z.literal("schedule"), config: scheduleTriggerConfigSchema }),
  z.object({ ...createTriggerBaseShape, type: z.literal("event"), config: eventTriggerConfigSchema }),
  z.object({ ...createTriggerBaseShape, type: z.literal("watch"), config: watchTriggerConfigSchema }),
  z.object({ ...createTriggerBaseShape, type: z.literal("rss"), config: rssTriggerConfigSchema }),
  z.object({ ...createTriggerBaseShape, type: z.literal("run_completed"), config: runCompletedTriggerConfigSchema }),
  z.object({ ...createTriggerBaseShape, type: z.literal("email_in"), config: emailInTriggerConfigSchema }),
  z.object({ ...createTriggerBaseShape, type: z.literal("message"), config: messageTriggerConfigSchema })
]);
export type CreateTriggerRequest = z.infer<typeof createTriggerRequestSchema>;

/**
 * Request body: PATCH /api/auto/triggers/{id}. All fields optional (mirrors
 * updateAutoScheduleRequestSchema). `type` is IMMUTABLE — a config patch must
 * match the trigger's existing type (server-enforced).
 */
export const updateTriggerRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  approvalId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  budgetCents: z.number().int().nonnegative().optional(),
  filters: z.array(triggerFilterSchema).max(10).optional(),
  mapping: triggerMappingSchema.optional(),
  destinations: z.array(destinationSchema).max(5).optional(),
  rateLimit: triggerRateLimitSchema.optional(),
  enabled: z.boolean().optional(),
  config: z
    .union([
      scheduleTriggerConfigSchema,
      eventTriggerConfigSchema,
      watchTriggerConfigSchema,
      rssTriggerConfigSchema,
      runCompletedTriggerConfigSchema,
      emailInTriggerConfigSchema,
      messageTriggerConfigSchema
    ])
    .optional()
});
export type UpdateTriggerRequest = z.infer<typeof updateTriggerRequestSchema>;

/** Response body: GET /api/auto/triggers. */
export const listTriggersResponseSchema = z.object({
  triggers: z.array(triggerSchema)
});
export type ListTriggersResponse = z.infer<typeof listTriggersResponseSchema>;

// ---------------------------------------------------------------------------
// Fire log (abuse/cost observability — NOT fake runs)
// ---------------------------------------------------------------------------

/**
 * One trigger-fire attempt outcome. Suppressed/filtered/skipped fires create a
 * fire-log row, NEVER a run record — runs stay real executions only.
 */
export const triggerFireLogSchema = z.object({
  id: z.string().min(1),
  triggerId: z.string().min(1),
  /** ISO of the fire attempt. */
  at: z.string().min(1),
  outcome: triggerFireOutcomeSchema,
  /** The run created (outcome === "run_created"). */
  runId: z.string().min(1).nullable().optional(),
  /** Short outcome detail (filter path, error message, rate-limit note). */
  detail: z.string().nullable().optional()
});
export type TriggerFireLog = z.infer<typeof triggerFireLogSchema>;

/** Response body: GET /api/auto/triggers/{id}/fire-logs. */
export const listTriggerFireLogsResponseSchema = z.object({
  fireLogs: z.array(triggerFireLogSchema)
});
export type ListTriggerFireLogsResponse = z.infer<typeof listTriggerFireLogsResponseSchema>;

/** Request body: POST /api/auto/triggers/{id}/test-fire (dry-run with a sample). */
export const testFireTriggerRequestSchema = z.object({
  /** Sample event payload; absent = the trigger type's canned sample. */
  sampleEvent: z.unknown().optional()
});
export type TestFireTriggerRequest = z.infer<typeof testFireTriggerRequestSchema>;

/** Response body: POST /api/auto/triggers/{id}/test-fire. */
export const testFireTriggerResponseSchema = z.object({
  fireLog: triggerFireLogSchema,
  /** Set when the test fire created a real run. */
  runId: z.string().min(1).optional()
});
export type TestFireTriggerResponse = z.infer<typeof testFireTriggerResponseSchema>;

// ---------------------------------------------------------------------------
// Affordability seam (canStartRun — pre-fire ledger check)
// ---------------------------------------------------------------------------

/** Request: can this user afford to start a run right now? */
export const canStartRunRequestSchema = z.object({
  userId: z.string().min(1),
  /** Billing mode of the prospective run. */
  mode: inferenceModeSchema
});
export type CanStartRunRequest = z.infer<typeof canStartRunRequestSchema>;

/** Why a canStartRun check said no. */
export const canStartRunReasonSchema = z.enum([
  "insufficient_funds",
  "ledger_unavailable"
]);
export type CanStartRunReason = z.infer<typeof canStartRunReasonSchema>;

/**
 * Response: the affordability verdict. For modes in
 * CAN_START_FAIL_CLOSED_MODES ("managed"), `ledger_unavailable` FAILS CLOSED
 * (the fire is skipped → outcome "skipped_funds"); BYO may proceed.
 */
export const canStartRunResponseSchema = z.object({
  allowed: z.boolean(),
  reason: canStartRunReasonSchema.optional(),
  detail: z.string().optional()
});
export type CanStartRunResponse = z.infer<typeof canStartRunResponseSchema>;

// ---------------------------------------------------------------------------
// Route builders
// ---------------------------------------------------------------------------

/** Seam A — browser routes for triggers/event-sources/connections. */
export const autoTriggerRoutes = {
  triggers: () => "/api/auto/triggers",
  trigger: (id: string) => `/api/auto/triggers/${encodeURIComponent(id)}`,
  testFireTrigger: (id: string) => `/api/auto/triggers/${encodeURIComponent(id)}/test-fire`,
  triggerFireLogs: (id: string) => `/api/auto/triggers/${encodeURIComponent(id)}/fire-logs`,
  eventSources: () => "/api/auto/event-sources",
  eventSource: (id: string) => `/api/auto/event-sources/${encodeURIComponent(id)}`,
  eventSourceEvents: (id: string) =>
    `/api/auto/event-sources/${encodeURIComponent(id)}/events`,
  replayEvent: (id: string) => `/api/auto/event-sources/${encodeURIComponent(id)}/replay`,
  connections: () => "/api/auto/connections",
  connection: (id: string) => `/api/auto/connections/${encodeURIComponent(id)}`
} as const;

/** Seam C — public event ingest (per-source bearer token, IFTTT-style path). */
export const autoEventIngestRoutes = {
  emit: (sourceId: string, eventName: string) =>
    `/api/hooks/auto/events/${encodeURIComponent(sourceId)}/${encodeURIComponent(eventName)}`
} as const;
