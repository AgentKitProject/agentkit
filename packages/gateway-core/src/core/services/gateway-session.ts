/**
 * Gateway session lifecycle service — create / delete, with an optional
 * entitlement gate.
 *
 * Tier-3 requires a per-buyer entitlement check on every session start (reuse
 * the Market `EntitlementRepository`). This service wires that as an OPTIONAL
 * callback so the core stays provider/cloud-agnostic and the seam is ready for
 * Tier-3 without the core depending on the Market entitlement store. The default
 * is allow (so self-host / free deployments work with no entitlement wiring).
 */

import type { SessionStore } from "../ports.js";
import type {
  BillingMode,
  ByoProviderConfig,
  CreateSessionInput,
  GatewaySession,
} from "../types.js";
import { SESSION_TTL_SECONDS } from "../config.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the entitlement check denies session creation. */
export class EntitlementDeniedError extends Error {
  readonly name = "EntitlementDeniedError";
  constructor(
    public readonly userId: string,
    public readonly kitId: string,
    public readonly reason?: string,
  ) {
    super(
      `User ${userId} is not entitled to run kit ${kitId}` +
        (reason ? `: ${reason}` : "."),
    );
  }
}

// ---------------------------------------------------------------------------
// Entitlement hook
// ---------------------------------------------------------------------------

export interface EntitlementCheckArgs {
  userId: string;
  kitId: string;
  billingMode: BillingMode;
}

/**
 * Optional entitlement gate. Returns `{ allowed: true }` to permit the session
 * or `{ allowed: false, reason? }` to deny it. Injected at the composition root
 * (hosted: backed by the Market EntitlementRepository). Defaults to allow.
 */
export type EntitlementCheck = (
  args: EntitlementCheckArgs,
) => Promise<{ allowed: boolean; reason?: string }>;

const ALLOW_ALL: EntitlementCheck = async () => ({ allowed: true });

// ---------------------------------------------------------------------------
// Create-session input / deps
// ---------------------------------------------------------------------------

export interface CreateGatewaySessionDeps {
  sessions: SessionStore;
  now: () => string;
  /** Optional entitlement gate; defaults to allow-all. */
  entitlementCheck?: EntitlementCheck;
  /** Session TTL in seconds. Defaults to SESSION_TTL_SECONDS (4h). */
  ttlSeconds?: number;
}

/**
 * The client-facing create-session payload (mirrors the tier3-gateway stub):
 *   POST /gateway/sessions { kitId?, billing, model, systemPromptRef? }
 *
 * The server never trusts client-supplied system prompt CONTENT — only a
 * reference key. In hosted managed mode the gateway resolves the secret prompt
 * server-side from the kit package; `systemPromptRef` defaults to the kitId.
 */
export interface CreateGatewaySessionRequest {
  /** The authenticated buyer. */
  userId: string;
  /** Kit being run (entitlement-checked). Optional for raw self-host prompts. */
  kitId?: string;
  /** Display slug; denormalised for logging. Defaults to kitId. */
  kitSlug?: string;
  /** Billing mode. */
  billing: BillingMode;
  /** Server-side reference to the injected system prompt. Defaults to kitId. */
  systemPromptRef?: string;
  /** BYO provider config (required iff billing === "byo"). */
  byoProviderConfig?: ByoProviderConfig | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Creates a gateway session after running the (optional) entitlement gate.
 *
 * @throws EntitlementDeniedError if the entitlement check denies access.
 */
export async function createGatewaySession(
  deps: CreateGatewaySessionDeps,
  request: CreateGatewaySessionRequest,
): Promise<GatewaySession> {
  const kitId = request.kitId ?? "";
  const entitlementCheck = deps.entitlementCheck ?? ALLOW_ALL;

  const verdict = await entitlementCheck({
    userId: request.userId,
    kitId,
    billingMode: request.billing,
  });
  if (!verdict.allowed) {
    throw new EntitlementDeniedError(request.userId, kitId, verdict.reason);
  }

  const now = deps.now();
  const ttl = deps.ttlSeconds ?? SESSION_TTL_SECONDS;
  const expiresAt = Math.floor(Date.parse(now) / 1000) + ttl;

  const input: CreateSessionInput = {
    userId: request.userId,
    kitId,
    kitSlug: request.kitSlug ?? kitId,
    systemPromptRef: request.systemPromptRef ?? kitId,
    billingMode: request.billing,
    byoProviderConfig: request.byoProviderConfig ?? null,
    createdAt: now,
    expiresAt,
  };

  return deps.sessions.createSession(input);
}

/** Deletes a session (buyer-initiated end). */
export async function deleteGatewaySession(
  deps: Pick<CreateGatewaySessionDeps, "sessions">,
  sessionId: string,
): Promise<void> {
  await deps.sessions.deleteSession(sessionId);
}
