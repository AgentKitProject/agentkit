// PUBLIC event ingest (Seam C) — POST /api/hooks/auto/events/{sourceId}/{eventName}.
//
// A FIFTH auth surface, sibling of the per-webhook-secret ingest: authorization
// is EITHER the per-source bearer token (custom/generic sources; header
// x-auto-event-token or ?token=) OR the provider's inbound signature
// (github/stripe/slack HMAC over the RAW body; SNS certificate verification).
// NEVER a cookie, bearer JWT, or service key (CLAUDE.md hard rule #4).
//
// PIPELINE (ordered):
//   a. resolve source by id           → uniform terse 401 on missing/disabled
//   b. AUTH (token or signature)      → uniform terse 401 on any failure
//   c. L2 rate limit (token buckets)  → 429 + Retry-After (REJECT, never queue)
//   d. payload cap                    → 413 (> EVENT_PAYLOAD_MAX_BYTES)
//   e. append to the inspector ring buffer + recordEvent on the source
//   f. fan out to subscribed event-type triggers (consumeTriggerEvent)
//   g. respond emitEventResponseSchema { accepted, eventId }
//
// RATE-LIMIT SEMANTICS (per replica): the token buckets are IN-MEMORY, so the
// effective limit scales with the replica count (N replicas → up to N× the
// nominal rate) and resets on restart. That is deliberate — L2 is an abuse
// valve, not billing; the authoritative cost gates are L3 (canStartRun) and
// the per-trigger maxPerHour inside consumeTriggerEvent.
//
// MIRROR of apps/forge/server/core/event-ingest.ts (keep in lockstep).

import {
  EVENT_PAYLOAD_MAX_BYTES,
  extractSnsSubscribeConfirmation,
  parseApprovalCallback,
  parseSlackInteractionPayload,
  verifyDiscord,
  verifyGithub,
  verifySlack,
  verifySnsMessage,
  verifySourceToken,
  verifyStripe,
  verifyTelegram,
  type EventSource,
  type MessagePlatform,
  type ResolvePendingApprovalResult,
} from "@agentkitforge/auto-core";
import { autoErrorCodeSchema, eventNameSchema } from "@agentkitforge/contracts";
import {
  fanOutEvent,
  getEventStorage,
  resolveApprovalFromCallback,
} from "@/server/core/auto-events";

// ---------------------------------------------------------------------------
// Constants (exported)
// ---------------------------------------------------------------------------

/** Header carrying the per-source ingest bearer token (or use `?token=`). */
export const AUTO_EVENT_TOKEN_HEADER = "x-auto-event-token";

/** L2 sustained per-source ingest rate (tokens refilled per minute). */
export const INGEST_SOURCE_RATE_PER_MIN = 60;
/** L2 per-source burst capacity. */
export const INGEST_SOURCE_BURST = 120;
/** L2 sustained per-user rate (sum across ALL of the user's sources). */
export const INGEST_USER_RATE_PER_MIN = 300;
/** L2 per-user burst capacity (== sustained rate; no extra burst headroom). */
export const INGEST_USER_BURST = 300;

// ---------------------------------------------------------------------------
// Token-bucket limiter (in-memory, per replica)
// ---------------------------------------------------------------------------

interface BucketState {
  tokens: number;
  lastMs: number;
}

/**
 * A classic token bucket: `capacity` tokens max, refilled continuously at
 * `refillPerMin` tokens/minute. `take` consumes one token or reports the
 * seconds until one is available. The clock is injectable for tests.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMin: number,
    private readonly nowMs: () => number = Date.now,
  ) {}

  take(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.nowMs();
    const state = this.buckets.get(key) ?? { tokens: this.capacity, lastMs: now };
    const elapsedMin = Math.max(0, now - state.lastMs) / 60_000;
    state.tokens = Math.min(this.capacity, state.tokens + elapsedMin * this.refillPerMin);
    state.lastMs = now;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.buckets.set(key, state);
      return { allowed: true, retryAfterSec: 0 };
    }
    this.buckets.set(key, state);
    const missing = 1 - state.tokens;
    const retryAfterSec = Math.max(1, Math.ceil((missing / this.refillPerMin) * 60));
    return { allowed: false, retryAfterSec };
  }

  reset(): void {
    this.buckets.clear();
  }
}

let sourceLimiter = new TokenBucketLimiter(INGEST_SOURCE_BURST, INGEST_SOURCE_RATE_PER_MIN);
let userLimiter = new TokenBucketLimiter(INGEST_USER_BURST, INGEST_USER_RATE_PER_MIN);

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Injectable pieces for tests (SNS cert/confirmation fetch, clock). */
export interface EventIngestOverrides {
  /** Fetch used for the SNS signing-cert download AND the SubscribeURL
   *  confirmation GET. Defaults to global fetch. Tests MUST inject it. */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
  /** Clock (ms) for the rate limiter + signature timestamp windows. */
  nowMs?: () => number;
}

let overrides: EventIngestOverrides = {};

/** Test seam: inject fetch/clock; passing {} restores defaults. Also resets
 *  the rate-limit buckets so tests are isolated. */
export function setEventIngestOverridesForTests(next: EventIngestOverrides): void {
  overrides = next;
  const nowMs = next.nowMs ?? Date.now;
  sourceLimiter = new TokenBucketLimiter(INGEST_SOURCE_BURST, INGEST_SOURCE_RATE_PER_MIN, nowMs);
  userLimiter = new TokenBucketLimiter(INGEST_USER_BURST, INGEST_USER_RATE_PER_MIN, nowMs);
}

// ---------------------------------------------------------------------------
// The ingest handler
// ---------------------------------------------------------------------------

const UNAUTHORIZED = (): Response =>
  Response.json({ error: autoErrorCodeSchema.enum.unauthorized }, { status: 401 });

function presentedToken(request: Request, url: URL): string | null {
  const header = request.headers.get(AUTO_EVENT_TOKEN_HEADER);
  if (header && header.length > 0) return header;
  const token = url.searchParams.get("token");
  if (token && token.length > 0) return token;
  return null;
}

/**
 * Authenticates the request against the source (see the auth matrix in the
 * module comment). Returns true only on a positive verification. NEVER logs
 * token/signature material.
 */
async function authenticate(
  source: EventSource,
  request: Request,
  url: URL,
  rawBody: string,
  nowIso: string,
): Promise<boolean> {
  const provider = source.kind === "provider" ? source.provider ?? "generic" : undefined;

  // Custom sources (and the "generic" provider shape) use OUR bearer token.
  if (source.kind === "custom" || provider === "generic") {
    const token = presentedToken(request, url);
    if (!token) return false;
    return verifySourceToken(token, source.tokenHash);
  }

  // Signature-mode providers REJECT token auth outright — a leaked bearer
  // token must never bypass signature verification.
  switch (provider) {
    case "github": {
      const secret = await revealSigningSecret(source);
      if (secret === undefined) return false; // no secret → cannot verify → reject
      return verifyGithub(request.headers.get("x-hub-signature-256"), rawBody, secret);
    }
    case "stripe": {
      const secret = await revealSigningSecret(source);
      if (secret === undefined) return false;
      return verifyStripe(request.headers.get("stripe-signature"), rawBody, secret, {
        now: nowIso,
      });
    }
    case "slack": {
      const secret = await revealSigningSecret(source);
      if (secret === undefined) return false;
      return verifySlack(
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
        rawBody,
        secret,
        { now: nowIso },
      );
    }
    case "telegram": {
      // Telegram webhook mode: the registered secret_token is echoed back in
      // this header on every update (constant-time compare vs the stored
      // signing secret). NO long-poll daemon exists — webhook only.
      const secret = await revealSigningSecret(source);
      if (secret === undefined) return false;
      return verifyTelegram(request.headers.get("x-telegram-bot-api-secret-token"), secret);
    }
    case "discord": {
      // Discord interactions endpoint: ed25519 over timestamp+rawBody. The
      // source's "signing secret" is the application PUBLIC KEY (hex).
      const secret = await revealSigningSecret(source);
      if (secret === undefined) return false;
      return verifyDiscord(
        request.headers.get("x-signature-ed25519"),
        request.headers.get("x-signature-timestamp"),
        rawBody,
        secret,
      );
    }
    case "sns": {
      let message: unknown;
      try {
        message = JSON.parse(rawBody);
      } catch {
        return false;
      }
      return verifySnsMessage(message, { fetchImpl: overrides.fetchImpl ?? fetch });
    }
    default:
      return false;
  }
}

/** Reveals the source's provider signing secret via the SecretStore, or
 *  undefined when none is configured / storage is unconfigured (→ reject). */
async function revealSigningSecret(source: EventSource): Promise<string | undefined> {
  try {
    const events = await getEventStorage();
    const ref = await events.eventSources.getSigningSecretRef(source.id);
    if (ref === undefined) return undefined;
    return await events.secrets.reveal(ref);
  } catch {
    // Unconfigured/failed secret storage = cannot verify = uniform reject.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Wave 4: messaging control-plane (handshakes + Approve/Deny callbacks)
// ---------------------------------------------------------------------------

function approvalAckText(result: ResolvePendingApprovalResult): string {
  switch (result.outcome) {
    case "approved":
      return result.runId !== undefined
        ? `Approved — run ${result.runId} started.`
        : `Approved — but no run started (${result.fireLog?.outcome ?? "gated"}).`;
    case "denied":
      return "Denied — the run will not start.";
    case "expired":
      return "This approval expired before it was actioned.";
    default:
      return "This approval is no longer actionable.";
  }
}

/**
 * Handles the SIGNATURE-VERIFIED provider control-plane requests that must
 * never become events:
 *   - slack `url_verification` → challenge echo (Events API handshake);
 *   - discord PING (type 1) → PONG (interactions endpoint validation);
 *   - Approve/Deny button callbacks (slack block_actions / telegram
 *     callback_query / discord component interaction) → pre-run approval
 *     resolution via the SAME server-side mechanism the hold created
 *     (resolveApprovalFromCallback → resolvePendingApprovalToken).
 * Returns null when the request is a REGULAR event (falls through to the
 * normal ring-buffer + fan-out pipeline). Runs AFTER auth: only verified
 * requests reach here (the documented handshakes are not a new
 * unauthenticated surface — they are signed like every other request).
 */
async function handleMessagingControlPlane(
  source: EventSource,
  platform: MessagePlatform,
  rawBody: string,
): Promise<Response | null> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = undefined;
  }
  const body =
    json !== null && typeof json === "object" ? (json as Record<string, unknown>) : undefined;

  if (platform === "slack") {
    if (body !== undefined && body["type"] === "url_verification") {
      const challenge = body["challenge"];
      return Response.json(
        { challenge: typeof challenge === "string" ? challenge : "" },
        { status: 200 },
      );
    }
    // Interactivity arrives form-encoded (payload=<json>) — never an event.
    const interaction = parseSlackInteractionPayload(rawBody);
    if (interaction !== null) {
      const callback = parseApprovalCallback("slack", interaction);
      if (callback !== null) {
        const result = await resolveApprovalFromCallback(source, callback.decision, callback.token);
        return Response.json(
          { response_type: "ephemeral", text: approvalAckText(result) },
          { status: 200 },
        );
      }
      return Response.json(
        { response_type: "ephemeral", text: "Nothing to do." },
        { status: 200 },
      );
    }
    return null;
  }

  if (platform === "telegram") {
    const callback = parseApprovalCallback("telegram", json);
    if (callback !== null) {
      const result = await resolveApprovalFromCallback(source, callback.decision, callback.token);
      // Webhook-reply: answer the callback query inline (no bot-token call).
      const cq = body?.["callback_query"];
      const cqId =
        cq !== null && typeof cq === "object" ? (cq as { id?: unknown }).id : undefined;
      return Response.json(
        typeof cqId === "string"
          ? { method: "answerCallbackQuery", callback_query_id: cqId, text: approvalAckText(result) }
          : {},
        { status: 200 },
      );
    }
    // A foreign callback_query (not our buttons) is acked without an event.
    if (body?.["callback_query"] !== undefined) return Response.json({}, { status: 200 });
    return null;
  }

  // discord
  if (body !== undefined && body["type"] === 1) {
    return Response.json({ type: 1 }, { status: 200 }); // PING → PONG
  }
  const callback = parseApprovalCallback("discord", json);
  if (callback !== null) {
    const result = await resolveApprovalFromCallback(source, callback.decision, callback.token);
    return Response.json(
      { type: 4, data: { content: approvalAckText(result), flags: 64 } },
      { status: 200 },
    );
  }
  // A foreign component interaction is acked (deferred update) without an event.
  if (body !== undefined && body["type"] === 3) {
    return Response.json({ type: 6 }, { status: 200 });
  }
  return null;
}

/**
 * Handle one public ingest POST. Shared by both apps' route files; the route
 * is a thin wrapper (params + this call).
 */
export async function handleEventIngest(
  request: Request,
  sourceId: string,
  eventName: string,
): Promise<Response> {
  const nowMs = overrides.nowMs ?? Date.now;
  const receivedAt = new Date(nowMs()).toISOString();
  const url = new URL(request.url);

  // Path event name must be well-formed (dots/dashes/underscores only).
  const nameParsed = eventNameSchema.safeParse(eventName);
  if (!nameParsed.success) {
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: "Invalid event name." },
      { status: 400 },
    );
  }

  // (a) resolve the source — uniform terse 401 for missing AND disabled (no
  // probing which source ids exist).
  let events;
  try {
    events = await getEventStorage();
  } catch {
    return UNAUTHORIZED();
  }
  const source = await events.eventSources.getEventSource(sourceId);
  if (!source || !source.enabled) return UNAUTHORIZED();

  // Raw body FIRST: signature verification runs over the exact bytes.
  const rawBody = await request.text().catch(() => "");

  // SNS SubscriptionConfirmation: confirm server-side and store NO event. The
  // protection here is the SSRF host gate (extractSnsSubscribeConfirmation
  // vets the SubscribeURL against the anchored sns.<region>.amazonaws.com
  // pattern BEFORE any fetch) — confirming a subscription is idempotent, and a
  // message with a non-SNS SubscribeURL is rejected with the uniform 401.
  if (source.kind === "provider" && source.provider === "sns") {
    let message: unknown;
    try {
      message = JSON.parse(rawBody);
    } catch {
      message = undefined;
    }
    if (
      message !== null &&
      typeof message === "object" &&
      (message as { Type?: unknown }).Type === "SubscriptionConfirmation"
    ) {
      const subscribeUrl = extractSnsSubscribeConfirmation(message);
      if (subscribeUrl === undefined) return UNAUTHORIZED();
      const fetchImpl = overrides.fetchImpl ?? fetch;
      try {
        await fetchImpl(subscribeUrl);
      } catch {
        /* best-effort: SNS retries confirmations */
      }
      return Response.json({ accepted: true }, { status: 200 });
    }
  }

  // (b) AUTH — token (custom/generic) or provider signature. Uniform 401.
  const authed = await authenticate(source, request, url, rawBody, receivedAt);
  if (!authed) return UNAUTHORIZED();

  // (b2) Wave 4 messaging control-plane: handshakes (slack url_verification /
  // discord PING) and Approve/Deny callbacks. Signature-verified above; NEVER
  // stored as events and never fanned out. Handled BEFORE the L2 limiter so a
  // provider's endpoint-validation probe can never 429 during setup.
  if (
    source.kind === "provider" &&
    (source.provider === "slack" || source.provider === "telegram" || source.provider === "discord")
  ) {
    const control = await handleMessagingControlPlane(source, source.provider, rawBody);
    if (control !== null) return control;
  }

  // (c) L2 rate limit: per source, then per user (sum across sources). REJECT
  // with Retry-After — never queue.
  const bySource = sourceLimiter.take(`src:${source.id}`);
  const byUser = bySource.allowed
    ? userLimiter.take(`user:${source.userId}`)
    : { allowed: true, retryAfterSec: 0 };
  if (!bySource.allowed || !byUser.allowed) {
    const retryAfter = Math.max(bySource.retryAfterSec, byUser.retryAfterSec);
    return Response.json(
      { error: autoErrorCodeSchema.enum.invalid_request, message: "Rate limit exceeded." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // (d) payload cap.
  if (Buffer.byteLength(rawBody, "utf8") > EVENT_PAYLOAD_MAX_BYTES) {
    return Response.json(
      {
        error: autoErrorCodeSchema.enum.invalid_request,
        message: `Payload exceeds ${EVENT_PAYLOAD_MAX_BYTES} bytes.`,
      },
      { status: 413 },
    );
  }

  // Parse the payload: JSON when it parses, else the raw text, else absent.
  let payload: unknown;
  if (rawBody.length > 0) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = rawBody;
    }
  }

  // (e) inspector ring buffer + source counters.
  const event = await events.receivedEvents.appendEvent({
    sourceId: source.id,
    name: nameParsed.data,
    receivedAt,
    payload,
  });
  await events.eventSources.recordEvent(source.id, receivedAt);

  // (f) fan out to the owner's subscribed event-type triggers. The event is
  // ALREADY stored — a filtered/suppressed fan-out never loses the event.
  await fanOutEvent(source, nameParsed.data, payload, receivedAt);

  // (g) contracts emitEventResponseSchema — EXCEPT discord slash commands
  // (type 2), which must be answered in Discord's interaction-response format
  // within 3s (an ephemeral ack; the run reports back via message_reply).
  if (source.kind === "provider" && source.provider === "discord") {
    const parsedType =
      payload !== null && typeof payload === "object"
        ? (payload as { type?: unknown }).type
        : undefined;
    if (parsedType === 2) {
      return Response.json(
        { type: 4, data: { content: "AgentKitAuto: event accepted.", flags: 64 } },
        { status: 200 },
      );
    }
  }
  return Response.json({ accepted: true, eventId: event.id }, { status: 202 });
}
