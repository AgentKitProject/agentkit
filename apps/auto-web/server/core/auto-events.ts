// AgentKitAuto — event-driven expansion composition (unified Triggers +
// EventSources + received-event inspector + fire logs).
//
// ADDITIVE, NO MIGRATION: this module lives ALONGSIDE the legacy schedule/
// webhook surfaces (server/core/auto.ts) — nothing there changes behavior. The
// engine (consumeTriggerEvent gate chain, runDueScheduleTriggers, mapping
// evaluator, signature verifiers) lives in @agentkitforge/auto-core; this
// module only wires storage + validation + the injected seams:
//
//   - STORAGE    — the `events` bundle off the SAME getAutoStorage() deps
//                  (pg on selfhost, Dynamo on aws; both adapters populate it).
//   - canStartRun— makeDefaultCanStartRun() (gateway ledger preflight; no-op
//                  allow on unmetered deployments) — server/core/can-start.ts.
//   - DISPATCH   — createAndDispatch re-routes through the EXACT startRun path
//                  on-demand/schedule/webhook runs use (approval gate, billing
//                  resolution, run create, active dispatcher), stamping
//                  `triggerId` provenance, WRAPPED in the L4 concurrency cap.
//
// AUTH NOTE: auth-agnostic, exactly like server/core/auto.ts — the cookie
// routes (/api/auto/*) and the bearer routes (/api/forge/auto/*) both resolve
// `userId` with their own helper and call these userId-keyed functions. The
// public ingest path (/api/hooks/auto/events/*) is a separate auth path
// (per-source token / provider signature) — see server/core/event-ingest.ts.
//
// MIRROR of apps/forge/server/core/auto-events.ts (keep the two in lockstep).

import {
  consumeTriggerEvent,
  runDueScheduleTriggers,
  runWatchPollSweep,
  runRssPollSweep,
  runRunCompletedPollSweep,
  runEmailInPollSweep,
  resolvePendingApprovalToken,
  normalizeMessageEvent,
  messageTriggerMatches,
  originFromMessagePayload,
  defaultTargetFromConnectionConfig,
  platformOfBotConnectionType,
  postPlatformMessage,
  buildApprovalCallbackData,
  checkConcurrency,
  countActiveRuns,
  resolveMaxConcurrentRuns,
  generateWebhookSecret,
  hashWebhookSecret,
  nextFireAfter,
  validateCron,
  CronParseError,
  SecretStoreUnconfiguredError,
  type ConsumeTriggerEventDeps,
  type CreateAndDispatchTriggerRun,
  type DnsResolver,
  type EmailInboxConfig,
  type EventStorageDeps,
  type FetchFn,
  type InboxGetFn,
  type InboxListFn,
  type InferenceMode,
  type MessagePlatform,
  type PendingTriggerApproval,
  type ReceivedEvent,
  type ResolvePendingApprovalResult,
  type S3ListObjectsFn,
  type Trigger,
  type TriggerEventInput,
  type TriggerFireLog,
  type TriggerSweepSummary,
} from "@agentkitforge/auto-core";
import {
  createEventSourceRequestSchema,
  createTriggerRequestSchema,
  updateEventSourceRequestSchema,
  updateTriggerRequestSchema,
  scheduleTriggerConfigSchema,
  eventTriggerConfigSchema,
  watchTriggerConfigSchema,
  rssTriggerConfigSchema,
  runCompletedTriggerConfigSchema,
  emailInTriggerConfigSchema,
  messageTriggerConfigSchema,
  testFireTriggerRequestSchema,
  type CreateEventSourceResponse,
  type EventSource,
  type PublicEventSource,
  type TestFireTriggerResponse,
  type TriggerType,
} from "@agentkitforge/contracts";
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { randomBytes } from "node:crypto";
import { getAppUrl } from "@/lib/url-config";
import {
  ApprovalDeniedError,
  AutoValidationError,
  getAutoStorage,
  isCloudRunDispatcher,
  resolveAutoBilling,
  startRun,
} from "@/server/core/auto";
import { makeDefaultCanStartRun } from "@/server/core/can-start";

// ---------------------------------------------------------------------------
// Constants + typed errors
// ---------------------------------------------------------------------------

/** Fan-out cap: at most this many event-type triggers consume one ingested
 *  event (abuse guard — a single POST can never fan into unbounded fires). */
export const MAX_SUBSCRIPTIONS_PER_EVENT = 20;

/**
 * Fallback per-fire budget (US cents) when a trigger carries no budgetCents
 * AND the approval ceiling is unlimited (0). Mirrors startRun's
 * UNLIMITED_RUN_FALLBACK_CAP_CENTS reasoning: a run can never carry 0.
 */
export const TRIGGER_DEFAULT_BUDGET_CENTS = 500;

/**
 * L4 concurrency cap breach. Thrown by the wrapped createAndDispatch BEFORE
 * any run is created; consumeTriggerEvent recognizes it BY NAME and records a
 * "suppressed_concurrency" fire log (contracts 0.22.0) with no circuit
 * penalty — load-shedding, not breakage.
 */
export class ConcurrencyCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyCapError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Wave 4: operator email inbox (SES inbound → S3) — env-sourced, inert unless
// BOTH AUTO_EMAIL_INBOX_BUCKET and AUTO_EMAIL_INBOX_DOMAIN are set.
// ---------------------------------------------------------------------------

/** Inbound-address domain (`<slug>@<domain>`), or undefined when unset. */
export function emailInboxDomain(): string | undefined {
  const domain = process.env.AUTO_EMAIL_INBOX_DOMAIN?.trim();
  return domain && domain.length > 0 ? domain : undefined;
}

/** Operator inbox config for the email-in poller (undefined = inert sweep). */
export function emailInboxConfigFromEnv(): EmailInboxConfig | undefined {
  const bucket = process.env.AUTO_EMAIL_INBOX_BUCKET?.trim();
  const domain = emailInboxDomain();
  if (!bucket || bucket.length === 0 || domain === undefined) return undefined;
  const region = process.env.AUTO_EMAIL_INBOX_REGION?.trim();
  const endpoint = process.env.AUTO_EMAIL_INBOX_S3_ENDPOINT?.trim();
  return {
    bucket,
    prefix: process.env.AUTO_EMAIL_INBOX_PREFIX?.trim() ?? "",
    domain,
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

/** SERVER-OWNED inbound address slug (never client-supplied — hard rule #3's
 *  sibling: the server owns generated identifiers). */
function generateEmailAddressSlug(): string {
  return `kit-${randomBytes(5).toString("hex")}`;
}

/**
 * Maps the shared domain errors to HTTP responses (the same mapping every
 * legacy Auto route inlines): validation → 400, approval → 403. Returns null
 * for anything else (the route rethrows). Shared by the cookie + bearer route
 * files so the two auth paths stay behaviorally identical.
 */
export function autoEventErrorResponse(error: unknown): Response | null {
  if (error instanceof ApprovalDeniedError) {
    return Response.json(
      { error: autoErrorCodeSchema.enum.approval_denied, message: error.message },
      { status: 403 },
    );
  }
  if (error instanceof AutoValidationError) {
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: error.message },
      { status: 400 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Storage access
// ---------------------------------------------------------------------------

/** The event-driven stores off the shared Auto storage deps. Both persistent
 *  adapters always populate `events`; a stub that lacks it fails loudly. */
export async function getEventStorage(): Promise<EventStorageDeps> {
  const storage = await getAutoStorage();
  if (!storage.events) {
    throw new Error(
      "Event-driven storage is unavailable (the configured Auto storage backend did not provide the events bundle).",
    );
  }
  return storage.events;
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

function zodMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** Per-type config schema map (PATCH validates config against the trigger's
 *  EXISTING type — `type` is immutable, server-enforced). */
const TRIGGER_CONFIG_SCHEMAS: Record<TriggerType, { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }> = {
  schedule: scheduleTriggerConfigSchema,
  event: eventTriggerConfigSchema,
  watch: watchTriggerConfigSchema,
  rss: rssTriggerConfigSchema,
  run_completed: runCompletedTriggerConfigSchema,
  email_in: emailInTriggerConfigSchema,
  message: messageTriggerConfigSchema,
};

/**
 * Re-checks that a non-revoked standing approval for (userId, kitRef) exists,
 * covers budgetCents, AND matches the supplied approvalId — the EXACT
 * requireScheduleApproval/requireWebhookApproval semantics. A trigger never
 * widens consent.
 */
async function requireTriggerApproval(input: {
  userId: string;
  kitRef: Trigger["kitRef"];
  budgetCents: number;
  approvalId: string;
}): Promise<void> {
  const storage = await getAutoStorage();
  const approval = await storage.approvals.getApprovalForKit(input.userId, input.kitRef);
  if (!approval) {
    throw new ApprovalDeniedError("No standing approval exists for this kit. Create one first.");
  }
  if (approval.revokedAt !== null) {
    throw new ApprovalDeniedError("The standing approval for this kit has been revoked.");
  }
  if (approval.id !== input.approvalId) {
    throw new AutoValidationError("approvalId does not match the standing approval for this kit.");
  }
  // A 0 ceiling = UNLIMITED (no per-run ceiling) — never blocks.
  if (approval.maxBudgetCents > 0 && input.budgetCents > approval.maxBudgetCents) {
    throw new ApprovalDeniedError(
      `Trigger budget (${input.budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`,
    );
  }
}

/** Validates a schedule-trigger cron/timezone and returns the first cursor. */
function computeScheduleCursor(cron: string, fromISO: string, timezone: string | undefined): string {
  try {
    validateCron(cron);
    return nextFireAfter(cron, fromISO, timezone ?? "UTC");
  } catch (err) {
    const detail = err instanceof CronParseError ? err.message : "invalid cron/timezone";
    throw new AutoValidationError(`Invalid schedule config: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

/**
 * Create a unified trigger. Body is validated with the contracts discriminated
 * schema; the standing approval is re-checked (never widens consent); a
 * schedule trigger gets its first cursor (next-fire ISO) stamped so the sweep
 * fires it at the first cron slot, not immediately.
 */
export async function createTrigger(userId: string, body: unknown): Promise<Trigger> {
  const parsed = createTriggerRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid trigger: ${zodMessage(parsed.error)}`);
  }
  const request = parsed.data;

  await requireTriggerApproval({
    userId,
    kitRef: request.kitRef,
    budgetCents: request.budgetCents ?? 0,
    approvalId: request.approvalId,
  });

  const createdAt = nowIso();

  // Per-type integrity checks. (`request2` may carry server-stamped config —
  // the generated email_in address.)
  let firstCursor: string | null = null;
  let request2 = request;
  if (request.type === "schedule") {
    firstCursor = computeScheduleCursor(request.config.cron, createdAt, request.config.timezone);
  } else if (request.type === "event") {
    const events = await getEventStorage();
    const source = await events.eventSources.getEventSource(request.config.sourceId);
    if (!source || source.userId !== userId) {
      throw new AutoValidationError("config.sourceId does not reference one of your event sources.");
    }
  } else if (request.type === "message") {
    // Wave 4: the inbound source must be the OWNER's provider source of the
    // trigger's platform; an optional reply connection must be the matching
    // bot type (its token stays in the SecretStore — S2).
    const events = await getEventStorage();
    const source = await events.eventSources.getEventSource(request.config.sourceId);
    if (!source || source.userId !== userId) {
      throw new AutoValidationError("config.sourceId does not reference one of your event sources.");
    }
    if (source.kind !== "provider" || source.provider !== request.config.platform) {
      throw new AutoValidationError(
        `config.sourceId must reference a "${request.config.platform}" provider event source.`,
      );
    }
    if (request.config.connectionId !== null && request.config.connectionId !== undefined) {
      const connection = await events.connections.getConnection(request.config.connectionId);
      if (!connection || connection.ownerType !== "user" || connection.ownerId !== userId) {
        throw new AutoValidationError("config.connectionId does not reference one of your connections.");
      }
      if (platformOfBotConnectionType(connection.type) !== request.config.platform) {
        throw new AutoValidationError(
          `config.connectionId must be a "${request.config.platform}_bot" connection.`,
        );
      }
    }
  } else if (request.type === "email_in") {
    const events = await getEventStorage();
    if (request.config.connectionId !== null && request.config.connectionId !== undefined) {
      // Self-host IMAP shape (poller support pending — the sweep skips it).
      const connection = await events.connections.getConnection(request.config.connectionId);
      if (!connection || connection.ownerType !== "user" || connection.ownerId !== userId) {
        throw new AutoValidationError("config.connectionId does not reference one of your connections.");
      }
      if (connection.type !== "imap") {
        throw new AutoValidationError('config.connectionId must be an "imap" connection.');
      }
    } else {
      // Hosted: the server GENERATES the inbound address (slug is server-owned
      // — any client-supplied value is discarded). Without an inbox domain the
      // address stays null and the poller is inert (degrade gracefully).
      const slug = generateEmailAddressSlug();
      const domain = emailInboxDomain();
      request2 = {
        ...request,
        config: {
          ...request.config,
          addressSlug: slug,
          address: domain !== undefined ? `${slug}@${domain}` : null,
        },
      };
    }
  }
  const events = await getEventStorage();
  const trigger = await events.triggers.createTrigger({ ...request2, userId, createdAt });
  if (firstCursor !== null) {
    await events.triggers.updateCursor(trigger.id, firstCursor);
    return (await events.triggers.getTrigger(trigger.id)) ?? { ...trigger, cursor: firstCursor };
  }
  return trigger;
}

/** List a user's triggers. */
export async function listTriggers(userId: string): Promise<Trigger[]> {
  const events = await getEventStorage();
  return events.triggers.listTriggersByUser(userId);
}

/** Get one trigger, ownership-checked. Null for missing/cross-user (→ 404). */
export async function getTrigger(userId: string, triggerId: string): Promise<Trigger | null> {
  const events = await getEventStorage();
  const trigger = await events.triggers.getTrigger(triggerId);
  if (!trigger || trigger.userId !== userId) return null;
  return trigger;
}

/**
 * Patch a trigger (edit / enable / disable), ownership-checked. `type` is
 * IMMUTABLE: a config patch must match the trigger's existing type.
 *
 * CIRCUIT RESET: ANY patch with `enabled: true` clears the circuit state
 * (consecutiveFailures = 0, pausedAt = null) — the contracts PATCH schema
 * carries no circuit field by design; the UI's "Resume" sends
 * PATCH { enabled: true } and this is its server-side semantics.
 */
export async function updateTrigger(
  userId: string,
  triggerId: string,
  body: unknown,
): Promise<Trigger | null> {
  const events = await getEventStorage();
  const current = await events.triggers.getTrigger(triggerId);
  if (!current || current.userId !== userId) return null;

  const parsed = updateTriggerRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid trigger patch: ${zodMessage(parsed.error)}`);
  }
  const patch = parsed.data;

  // Config must match the EXISTING type (type is immutable).
  if (patch.config !== undefined) {
    const schema = TRIGGER_CONFIG_SCHEMAS[current.type];
    const configParsed = schema.safeParse(patch.config);
    if (!configParsed.success) {
      throw new AutoValidationError(
        `config does not match the trigger's type ("${current.type}") — type is immutable.`,
      );
    }
  }

  // Consent/budget-affecting edits re-run the approval gate.
  if (patch.budgetCents !== undefined || patch.approvalId !== undefined) {
    await requireTriggerApproval({
      userId,
      kitRef: current.kitRef,
      budgetCents: patch.budgetCents ?? current.budgetCents ?? 0,
      approvalId: patch.approvalId ?? current.approvalId,
    });
  }

  // Schedule cadence changes (or re-enabling) recompute the cursor so a
  // long-disabled schedule doesn't fire for missed slots.
  const reEnabling = patch.enabled === true && !current.enabled;
  let nextCursor: string | null | undefined;
  if (current.type === "schedule") {
    const nextConfig =
      patch.config !== undefined
        ? (patch.config as { cron: string; timezone?: string })
        : (current.config as { cron: string; timezone?: string });
    if (patch.config !== undefined || reEnabling) {
      nextCursor = computeScheduleCursor(nextConfig.cron, nowIso(), nextConfig.timezone);
    }
  }

  const updated = await events.triggers.updateTrigger(triggerId, {
    ...patch,
    updatedAt: nowIso(),
  });
  if (!updated) return null;

  if (nextCursor !== undefined) {
    await events.triggers.updateCursor(triggerId, nextCursor);
  }
  // enabled: true = circuit reset (clears consecutiveFailures + pausedAt) —
  // the UI's "Resume" affordance; also covers a plain re-enable.
  if (patch.enabled === true) {
    await events.triggers.resetCircuit(triggerId);
  }
  return (await events.triggers.getTrigger(triggerId)) ?? updated;
}

/** Delete a trigger, ownership-checked. False for missing/cross-user (→ 404). */
export async function deleteTrigger(userId: string, triggerId: string): Promise<boolean> {
  const events = await getEventStorage();
  const trigger = await events.triggers.getTrigger(triggerId);
  if (!trigger || trigger.userId !== userId) return false;
  await events.triggers.deleteTrigger(triggerId);
  return true;
}

/** Recent fire-log rows for a trigger, ownership-checked. Null → 404. */
export async function listTriggerFireLogs(
  userId: string,
  triggerId: string,
  limit = 100,
): Promise<TriggerFireLog[] | null> {
  const events = await getEventStorage();
  const trigger = await events.triggers.getTrigger(triggerId);
  if (!trigger || trigger.userId !== userId) return null;
  return events.fireLogs.listFireLogsByTrigger(triggerId, limit);
}

// ---------------------------------------------------------------------------
// Event-source CRUD (one-time plaintext ingest token — mirrors webhooks)
// ---------------------------------------------------------------------------

/** Public ingest endpoint BASE for a source (event name appended per fire). */
export function eventSourceIngestUrl(sourceId: string): string {
  const base = getAppUrl().replace(/\/$/, "");
  return `${base}/api/hooks/auto/events/${encodeURIComponent(sourceId)}`;
}

/** Strip the tokenHash (NEVER exposed) and attach the public ingest URL. */
export function toPublicEventSource(source: EventSource): PublicEventSource {
  const { tokenHash: _tokenHash, ...rest } = source;
  return { ...rest, ingestUrl: eventSourceIngestUrl(source.id) };
}

/**
 * Stores a WRITE-ONLY provider signing secret (create/update `signingSecret`)
 * in the SecretStore and returns the internal ref. When
 * AUTO_SECRET_ENCRYPTION_KEY is unset the typed unconfigured error becomes a
 * clear 400 — self-host-safe: sources WITHOUT signing secrets are unaffected.
 */
async function storeSigningSecret(plaintext: string): Promise<string> {
  const events = await getEventStorage();
  try {
    return await events.secrets.put(plaintext);
  } catch (err) {
    if (err instanceof SecretStoreUnconfiguredError || (err as Error)?.name === "SecretStoreUnconfiguredError") {
      throw new AutoValidationError(
        "Signing-secret storage is not configured on this instance (set AUTO_SECRET_ENCRYPTION_KEY).",
      );
    }
    throw err;
  }
}

/**
 * Create an event source. The ingest bearer token is generated server-side;
 * ONLY its sha256 hash is persisted (S2). The plaintext is returned ONCE in
 * this response and can never be retrieved again.
 *
 * A WRITE-ONLY `signingSecret` (provider HMAC verification) is moved straight
 * into the SecretStore (encrypted at rest); only the opaque ref is stored on
 * the source row (internal — responses reflect it as `hasSigningSecret`).
 */
export async function createEventSource(
  userId: string,
  body: unknown,
): Promise<CreateEventSourceResponse> {
  const parsed = createEventSourceRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid event source: ${zodMessage(parsed.error)}`);
  }
  const request = parsed.data;
  const signingSecretRef =
    request.signingSecret !== undefined ? await storeSigningSecret(request.signingSecret) : null;
  const token = generateWebhookSecret();
  const events = await getEventStorage();
  const source = await events.eventSources.createEventSource({
    userId,
    name: request.name,
    kind: request.kind,
    ...(request.provider !== undefined ? { provider: request.provider } : {}),
    tokenHash: hashWebhookSecret(token),
    hasSigningSecret: signingSecretRef !== null,
    ...(signingSecretRef !== null ? { signingSecretRef } : {}),
    enabled: true,
    createdAt: nowIso(),
  });
  return { ...toPublicEventSource(source), token };
}

/** List a user's event sources (tokenHash never exposed). */
export async function listEventSources(userId: string): Promise<PublicEventSource[]> {
  const events = await getEventStorage();
  const sources = await events.eventSources.listEventSourcesByUser(userId);
  return sources.map(toPublicEventSource);
}

/** Get one source, ownership-checked (public projection). Null → 404. */
export async function getEventSource(
  userId: string,
  sourceId: string,
): Promise<PublicEventSource | null> {
  const events = await getEventStorage();
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || source.userId !== userId) return null;
  return toPublicEventSource(source);
}

/**
 * Patch name/enabled (+ WRITE-ONLY signingSecret set/replace), ownership-
 * checked. A new signingSecret is stored encrypted (SecretStore) and the
 * superseded ref is deleted; the secret is never echoed. Null → 404.
 */
export async function updateEventSource(
  userId: string,
  sourceId: string,
  body: unknown,
): Promise<PublicEventSource | null> {
  const events = await getEventStorage();
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || source.userId !== userId) return null;
  const parsed = updateEventSourceRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid event-source patch: ${zodMessage(parsed.error)}`);
  }
  const { signingSecret, ...patch } = parsed.data;
  let signingSecretRef: string | undefined;
  let previousRef: string | undefined;
  if (signingSecret !== undefined) {
    previousRef = await events.eventSources.getSigningSecretRef(sourceId);
    signingSecretRef = await storeSigningSecret(signingSecret);
  }
  const updated = await events.eventSources.updateEventSource(sourceId, {
    ...patch,
    ...(signingSecretRef !== undefined ? { signingSecretRef } : {}),
  });
  // Replace semantics: drop the superseded secret (best-effort — an orphaned
  // ciphertext row is harmless; a missing new ref would not be).
  if (previousRef !== undefined && signingSecretRef !== undefined) {
    try {
      await events.secrets.delete(previousRef);
    } catch {
      /* best-effort */
    }
  }
  return updated ? toPublicEventSource(updated) : null;
}

/** Delete a source, ownership-checked (its stored signing secret is deleted
 *  best-effort too). False → 404. */
export async function deleteEventSource(userId: string, sourceId: string): Promise<boolean> {
  const events = await getEventStorage();
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || source.userId !== userId) return false;
  try {
    const ref = await events.eventSources.getSigningSecretRef(sourceId);
    if (ref !== undefined) await events.secrets.delete(ref);
  } catch {
    /* best-effort — an orphaned ciphertext row is harmless */
  }
  await events.eventSources.deleteEventSource(sourceId);
  return true;
}

/**
 * Rotate the ingest bearer token: a fresh plaintext token is generated, ONLY
 * its hash is persisted, and the plaintext is returned ONCE (the old token
 * stops authenticating immediately). Null → 404.
 */
export async function rotateEventSourceToken(
  userId: string,
  sourceId: string,
): Promise<CreateEventSourceResponse | null> {
  const events = await getEventStorage();
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || source.userId !== userId) return null;
  const token = generateWebhookSecret();
  const updated = await events.eventSources.updateEventSource(sourceId, {
    tokenHash: hashWebhookSecret(token),
  });
  if (!updated) return null;
  return { ...toPublicEventSource(updated), token };
}

/** Inspector list: the source's received-event ring buffer. Null → 404. */
export async function listSourceEvents(
  userId: string,
  sourceId: string,
  limit = 50,
): Promise<ReceivedEvent[] | null> {
  const events = await getEventStorage();
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || source.userId !== userId) return null;
  return events.receivedEvents.listEventsBySource(sourceId, limit);
}

// ---------------------------------------------------------------------------
// Trigger consume wiring (the injected deps for consumeTriggerEvent)
// ---------------------------------------------------------------------------

/**
 * The wrapped run-create + dispatch every trigger fire uses:
 *   1. L4 CONCURRENCY CAP — countActiveRuns(userId) vs resolveMaxConcurrentRuns()
 *      BEFORE any create/dispatch; over cap → typed ConcurrencyCapError (the
 *      runner logs an `error` fire log with the detail).
 *   2. startRun — the EXACT on-demand/schedule/webhook path (approval gate,
 *      billing resolution, v2 balance preflight, create, active dispatcher),
 *      SERVICE MODE (the trigger's userId drives kit-context resolution),
 *      stamping triggerId provenance.
 */
const createAndDispatch: CreateAndDispatchTriggerRun = async ({ trigger, input }) => {
  const storage = await getAutoStorage();

  // (1) L4 concurrency cap.
  const active = await countActiveRuns(storage.runs, trigger.userId);
  const verdict = checkConcurrency({ active, max: resolveMaxConcurrentRuns() });
  if (!verdict.allowed) {
    throw new ConcurrencyCapError(
      verdict.detail ?? "Concurrent-run limit reached; fire suppressed.",
    );
  }

  // (2) Effective per-fire budget: the trigger's own budget when positive,
  // else the approval ceiling, else the named fallback (a run never carries 0).
  let budgetCents = trigger.budgetCents ?? 0;
  if (budgetCents <= 0) {
    const approval = await storage.approvals.getApprovalForKit(trigger.userId, trigger.kitRef);
    budgetCents =
      approval && approval.maxBudgetCents > 0
        ? approval.maxBudgetCents
        : TRIGGER_DEFAULT_BUDGET_CENTS;
  }

  return startRun({
    userId: trigger.userId,
    kitRef: trigger.kitRef,
    prompt: input.prompt,
    budgetCents,
    ...(trigger.model ? { model: trigger.model } : {}),
    ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    // Wave 3b: event metadata (e.g. run_completed chainDepth) persists onto
    // run.input.event — the chain loop guard's carrier.
    ...(input.event !== undefined ? { event: input.event } : {}),
    kitContext: { serviceUserId: trigger.userId },
    // Contracts 0.22.0: non-schedule trigger types use the dedicated "event"
    // RunTrigger value; triggerId carries the precise provenance.
    trigger: trigger.type === "schedule" ? "schedule" : "event",
    triggerId: trigger.id,
  });
};

/** Global fetch adapted to auto-core's injected FetchFn shape (platform posts). */
const defaultPlatformFetch: FetchFn = (url, init) => fetch(url, init as RequestInit);

/**
 * Wave 4: sends the pre-run Approve/Deny prompt for a HELD fire through the
 * trigger's bot connection (message trigger `config.connectionId`, else the
 * first `message_reply` destination's connection). The target is the
 * ORIGINATING message (re-derived from the held payload) or the connection's
 * configured default channel/chat. S2: the bot token is revealed server-side
 * here and handed straight to the platform post. Throws on any failure — the
 * runner records "prompt not delivered" and the hold simply expires.
 */
async function sendApprovalPrompt(
  pending: PendingTriggerApproval,
  plaintextToken: string,
  trigger: Trigger,
  event: TriggerEventInput,
): Promise<void> {
  const events = await getEventStorage();
  let connectionId: string | null | undefined =
    trigger.type === "message" ? trigger.config.connectionId : undefined;
  if (connectionId === null || connectionId === undefined) {
    connectionId = (trigger.destinations ?? []).find((d) => d.type === "message_reply")?.connectionId;
  }
  if (connectionId === undefined || connectionId === null) {
    throw new Error("No bot connection is configured for approval prompts.");
  }
  const connection = await events.connections.getConnection(connectionId);
  if (!connection) throw new Error("Approval-prompt connection not found.");
  if (connection.ownerType === "user" && connection.ownerId !== trigger.userId) {
    throw new Error("Approval-prompt connection is not owned by the trigger's user.");
  }
  const platform = platformOfBotConnectionType(connection.type);
  if (platform === undefined) {
    throw new Error(`Approval prompts require a bot connection (got "${connection.type}").`);
  }
  if (!connection.secretRef) throw new Error("Bot connection has no stored token.");
  const target =
    (trigger.type === "message"
      ? originFromMessagePayload(platform as MessagePlatform, event.payload)
      : undefined) ??
    defaultTargetFromConnectionConfig(
      platform as MessagePlatform,
      connection.config as Record<string, unknown>,
    );
  if (target === undefined) {
    throw new Error(
      "No target for the approval prompt (set a default channel/chat id on the bot connection).",
    );
  }
  const botToken = await events.secrets.reveal(connection.secretRef);
  const kitRef = trigger.kitRef as { source: string; slug?: string; marketKitId?: string; localKitId?: string };
  const kitLabel =
    kitRef.source === "market"
      ? kitRef.slug ?? kitRef.marketKitId ?? "market-kit"
      : kitRef.localKitId ?? "local-kit";
  const result = await postPlatformMessage({
    target,
    botToken,
    text: `[AgentKitAuto] Trigger "${trigger.name}" wants to run ${kitLabel} (event "${pending.event.name}"). Approve to start the run.`,
    approval: {
      approveData: buildApprovalCallbackData("approve", plaintextToken),
      denyData: buildApprovalCallbackData("deny", plaintextToken),
    },
    fetchImpl: defaultPlatformFetch,
  });
  if (result.status !== "delivered") {
    throw new Error(result.error ?? "Approval prompt delivery failed.");
  }
}

/** The Wave 4 approval seams added to every consume-deps bundle (absent when
 *  the storage backend lacks a pending store → requireApproval fails closed). */
function approvalSeams(events: EventStorageDeps): Partial<ConsumeTriggerEventDeps> {
  return events.pendingApprovals !== undefined
    ? { pendingApprovals: events.pendingApprovals, onApprovalRequested: sendApprovalPrompt }
    : {};
}

/**
 * Wave 4: resolves an Approve/Deny button callback that arrived on the ingest
 * route (already provider-signature-verified). Ownership: the pending hold
 * must belong to the SOURCE owner (uniform not_found otherwise). Approve
 * re-presents the held event through the FULL gate chain — S4: pre-run only.
 */
export async function resolveApprovalFromCallback(
  source: EventSource,
  decision: "approve" | "deny",
  token: string,
): Promise<ResolvePendingApprovalResult> {
  const events = await getEventStorage();
  if (events.pendingApprovals === undefined) return { outcome: "not_found" };
  const pending = await events.pendingApprovals.findByTokenHash(hashWebhookSecret(token));
  if (!pending) return { outcome: "not_found" };
  const trigger = await events.triggers.getTrigger(pending.triggerId);
  const storage = await getAutoStorage();
  const deps: ConsumeTriggerEventDeps = trigger
    ? await buildTriggerConsumeDeps(trigger)
    : {
        triggers: events.triggers,
        approvals: storage.approvals,
        fireLogs: events.fireLogs,
        canStartRun: makeDefaultCanStartRun(),
        createAndDispatch,
        inferenceMode: "managed",
        ...approvalSeams(events),
      };
  return resolvePendingApprovalToken(token, decision, source.userId, deps, nowIso());
}

/**
 * Builds the ConsumeTriggerEventDeps for one trigger owner. inferenceMode is
 * resolved the SAME way runs resolve billing (resolveAutoBilling: protected
 * kits force managed; BYO key/org key → byo; errors fail CLOSED to managed so
 * an unresolvable mode can never widen spending).
 */
export async function buildTriggerConsumeDeps(trigger: Trigger): Promise<ConsumeTriggerEventDeps> {
  const storage = await getAutoStorage();
  const events = await getEventStorage();
  let inferenceMode: InferenceMode = "managed";
  try {
    const billing = await resolveAutoBilling({
      userId: trigger.userId,
      kitRef: trigger.kitRef,
      isCloudRun: isCloudRunDispatcher(),
      kitContext: { serviceUserId: trigger.userId },
    });
    inferenceMode = billing.inferenceMode;
  } catch {
    // Fail closed: an unresolvable billing mode is treated as managed.
  }
  return {
    triggers: events.triggers,
    approvals: storage.approvals,
    fireLogs: events.fireLogs,
    canStartRun: makeDefaultCanStartRun(),
    createAndDispatch,
    inferenceMode,
    ...approvalSeams(events),
  };
}

/** One consumed trigger during a fan-out. */
export interface FanOutResult {
  triggerId: string;
  fireLog: TriggerFireLog;
}

/**
 * Fan one accepted event out to the SOURCE OWNER's subscribed triggers:
 *   - event-type: config.sourceId matches AND (config.eventName null/absent OR
 *     equals the fired eventName) — the RAW payload is presented.
 *   - message-type (Wave 4): the source is a slack/telegram/discord provider
 *     source; the payload NORMALIZES to a message (handshakes/callbacks/bot
 *     posts do not) and matches the trigger's platform/scope/channel/events —
 *     the NORMALIZED payload is presented, with the reply `origin` stamped
 *     (metadata) so message_reply destinations can post back (S1: the message
 *     text remains event DATA under the mapping evaluator's caps).
 * The TOTAL fan-out is capped at MAX_SUBSCRIPTIONS_PER_EVENT; each consume is
 * isolated (consumeTriggerEvent never throws).
 */
export async function fanOutEvent(
  source: EventSource,
  eventName: string,
  payload: unknown,
  receivedAt: string,
): Promise<FanOutResult[]> {
  const events = await getEventStorage();
  const all = await events.triggers.listTriggersByUser(source.userId);

  const planned: { trigger: Trigger; event: TriggerEventInput }[] = [];
  for (const t of all) {
    if (!t.enabled) continue;
    if (
      t.type === "event" &&
      t.config.sourceId === source.id &&
      (t.config.eventName === null ||
        t.config.eventName === undefined ||
        t.config.eventName === eventName)
    ) {
      planned.push({ trigger: t, event: { name: eventName, payload, receivedAt } });
    }
  }
  const provider = source.kind === "provider" ? source.provider : undefined;
  if (provider === "slack" || provider === "telegram" || provider === "discord") {
    const normalized = normalizeMessageEvent(provider, payload);
    if (normalized !== null) {
      for (const t of all) {
        if (
          t.enabled &&
          t.type === "message" &&
          t.config.sourceId === source.id &&
          t.config.platform === provider &&
          messageTriggerMatches(t.config, normalized)
        ) {
          planned.push({
            trigger: t,
            event: {
              name: normalized.eventName,
              payload: normalized.payload,
              receivedAt,
              origin: normalized.origin,
            },
          });
        }
      }
    }
  }

  const results: FanOutResult[] = [];
  for (const { trigger, event } of planned.slice(0, MAX_SUBSCRIPTIONS_PER_EVENT)) {
    const deps = await buildTriggerConsumeDeps(trigger);
    const fireLog = await consumeTriggerEvent(trigger, event, deps);
    results.push({ triggerId: trigger.id, fireLog });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Test-fire + replay
// ---------------------------------------------------------------------------

/**
 * Test-fire a trigger through the REAL consume path (a REAL run on the user's
 * budget — no simulation): the supplied sampleEvent, else (event-type
 * triggers) the source's latest received event, else the degenerate no-payload
 * event. Null → 404.
 */
export async function testFireTrigger(
  userId: string,
  triggerId: string,
  body: unknown,
): Promise<TestFireTriggerResponse | null> {
  const events = await getEventStorage();
  const trigger = await events.triggers.getTrigger(triggerId);
  if (!trigger || trigger.userId !== userId) return null;

  const parsed = testFireTriggerRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AutoValidationError(`Invalid test-fire request: ${zodMessage(parsed.error)}`);
  }

  let payload: unknown = parsed.data.sampleEvent;
  let name = "test";
  if (payload === undefined && trigger.type === "event") {
    const latest = await events.receivedEvents.listEventsBySource(trigger.config.sourceId, 1);
    if (latest[0] !== undefined) {
      payload = latest[0].payload;
      name = latest[0].name;
    }
  } else if (trigger.type === "event" && trigger.config.eventName) {
    name = trigger.config.eventName;
  }
  if (trigger.type === "schedule") name = "schedule";

  const deps = await buildTriggerConsumeDeps(trigger);
  const fireLog = await consumeTriggerEvent(
    trigger,
    { name, ...(payload !== undefined ? { payload } : {}), receivedAt: nowIso() },
    deps,
  );
  return {
    fireLog,
    ...(fireLog.runId !== null && fireLog.runId !== undefined ? { runId: fireLog.runId } : {}),
  };
}

/**
 * Replay a STORED received event through the source's subscribed triggers
 * (owner-only; the fire clock is NOW, so rate limits/circuits apply afresh).
 * Null → 404 (missing/cross-user source, or an event that does not belong to
 * the source).
 */
export async function replayEvent(
  userId: string,
  sourceId: string,
  body: unknown,
): Promise<{ ok: true; results: FanOutResult[] } | null> {
  const events = await getEventStorage();
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || source.userId !== userId) return null;
  const eventId =
    body !== null && typeof body === "object" && typeof (body as { eventId?: unknown }).eventId === "string"
      ? (body as { eventId: string }).eventId
      : undefined;
  if (!eventId) {
    throw new AutoValidationError("eventId is required.");
  }
  const event = await events.receivedEvents.getEvent(eventId);
  if (!event || event.sourceId !== sourceId) return null;
  const results = await fanOutEvent(source, event.name, event.payload, nowIso());
  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// Sweep (schedule-TYPE triggers — additive next to runScheduleSweep)
// ---------------------------------------------------------------------------

/**
 * Process due schedule-TYPE triggers for this tick via auto-core's
 * runDueScheduleTriggers (cursor-advance-before-dispatch double-fire guard,
 * per-trigger isolation). ADDITIVE: the legacy runDueSchedules sweep is
 * untouched; the /api/internal/auto/sweep route runs both, isolated.
 *
 * NOTE: the sweep shares ONE deps bundle across all due triggers, so
 * inferenceMode uses the fail-closed default ("managed") rather than the
 * per-owner resolution the ingest fan-out performs — the conservative choice
 * (canStartRun can only ever be stricter). startRun still resolves the REAL
 * billing mode per run.
 */
export async function runTriggerScheduleSweep(): Promise<TriggerSweepSummary> {
  const storage = await getAutoStorage();
  const events = await getEventStorage();
  const deps: ConsumeTriggerEventDeps = {
    triggers: events.triggers,
    approvals: storage.approvals,
    fireLogs: events.fireLogs,
    canStartRun: makeDefaultCanStartRun(),
    createAndDispatch,
    inferenceMode: "managed",
    ...approvalSeams(events),
  };
  return runDueScheduleTriggers(deps, nowIso());
}

// ---------------------------------------------------------------------------
// Poll sweep (Wave 3b: watch / rss / run_completed — the generalized poller)
// ---------------------------------------------------------------------------

/** Per-poller summaries of one poll sweep (each poller is isolated). */
export interface TriggerPollSweepSummary {
  watch: TriggerSweepSummary;
  rss: TriggerSweepSummary;
  runCompleted: TriggerSweepSummary;
  /** Wave 4: hosted email-in (SES inbound → S3); inert when unconfigured. */
  emailIn: TriggerSweepSummary;
}

interface TriggerPollOverrides {
  s3List?: S3ListObjectsFn;
  fetchImpl?: FetchFn;
  resolver?: DnsResolver;
  /** Wave 4 email-in seams (offline tests). */
  inbox?: EmailInboxConfig;
  listInbox?: InboxListFn;
  getInboxObject?: InboxGetFn;
  getOwnerEmail?: (userId: string) => Promise<string | undefined>;
}

let pollOverrides: TriggerPollOverrides = {};

/** Test seam: inject the S3 list / fetch / DNS resolver (offline tests) —
 *  mirrors setConnectionVerifyOverridesForTests in auto-connections.ts. */
export function setTriggerPollOverridesForTests(overrides: TriggerPollOverrides): void {
  pollOverrides = overrides;
}

/** Real DNS resolver for the feed SSRF guard (A + AAAA), mirroring
 *  auto-connections' defaultDnsResolver. */
async function defaultPollDnsResolver(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/** Global fetch adapted to auto-core's injected FetchFn shape. */
const defaultPollFetch: FetchFn = (url, init) => fetch(url, init as RequestInit);

const EMPTY_SWEEP: TriggerSweepSummary = { processed: 0, dispatched: 0, skipped: 0, errors: [] };

/**
 * Run the Wave-3b pollers once (watch + rss + run_completed), ADDITIVE next to
 * runTriggerScheduleSweep on the same /api/internal/auto/sweep tick.
 *
 *   - Each poller consults the trigger's cursor for interval gating
 *     (config.intervalMinutes; watch floor 1 min, rss floor 5 min) and follows
 *     the persist-cursor-before-dispatch discipline.
 *   - ISOLATION at two levels: per-trigger inside each poller (auto-core), and
 *     per-poller here — one poller's storage failure never blocks the others.
 *   - S2: watch connection credentials are revealed by the poller server-side
 *     (SecretStore) and never leave it.
 *   - inferenceMode "managed" (fail-closed), exactly like the schedule sweep;
 *     startRun still resolves the REAL billing mode per run.
 */
export async function runTriggerPollSweep(): Promise<TriggerPollSweepSummary> {
  const storage = await getAutoStorage();
  const events = await getEventStorage();
  const base: ConsumeTriggerEventDeps = {
    triggers: events.triggers,
    approvals: storage.approvals,
    fireLogs: events.fireLogs,
    canStartRun: makeDefaultCanStartRun(),
    createAndDispatch,
    inferenceMode: "managed",
    ...approvalSeams(events),
  };

  const isolated = async (
    label: string,
    run: () => Promise<TriggerSweepSummary>,
  ): Promise<TriggerSweepSummary> => {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`[auto] ${label} poll sweep failed: ${message}`);
      return { ...EMPTY_SWEEP, errors: [{ triggerId: "*", error: message }] };
    }
  };

  const watch = await isolated("watch", () =>
    runWatchPollSweep(
      {
        ...base,
        connections: events.connections,
        secrets: events.secrets,
        ...(pollOverrides.s3List ? { s3List: pollOverrides.s3List } : {}),
      },
      nowIso(),
    ),
  );
  const rss = await isolated("rss", () =>
    runRssPollSweep(
      {
        ...base,
        fetchImpl: pollOverrides.fetchImpl ?? defaultPollFetch,
        resolver: pollOverrides.resolver ?? defaultPollDnsResolver,
      },
      nowIso(),
    ),
  );
  const runCompleted = await isolated("run_completed", () =>
    runRunCompletedPollSweep({ ...base, runs: storage.runs }, nowIso()),
  );
  // Wave 4 email-in: inert unless the operator inbox env is set. The
  // owner-email seam defaults UNWIRED — allowlist-empty email_in triggers
  // FAIL CLOSED (filtered) until an identity lookup is wired here.
  // TODO(seam): resolve the trigger owner's verified email via the identity
  // store and pass it as getOwnerEmail.
  const inbox = pollOverrides.inbox ?? emailInboxConfigFromEnv();
  const emailIn = await isolated("email_in", () =>
    runEmailInPollSweep(
      {
        ...base,
        ...(inbox !== undefined ? { inbox } : {}),
        ...(pollOverrides.listInbox ? { listInbox: pollOverrides.listInbox } : {}),
        ...(pollOverrides.getInboxObject ? { getInboxObject: pollOverrides.getInboxObject } : {}),
        ...(pollOverrides.getOwnerEmail ? { getOwnerEmail: pollOverrides.getOwnerEmail } : {}),
      },
      nowIso(),
    ),
  );

  return { watch, rss, runCompleted, emailIn };
}
