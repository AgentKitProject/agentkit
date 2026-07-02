/**
 * Affordability pre-check ("canStartRun") — a READ-ONLY verdict on whether a
 * user can afford to start an Auto run right now, computed against the credit
 * ledger. This is the COST-PREFLIGHT seam AgentKitAuto's trigger layer calls
 * BEFORE any compute (k8s Job) is dispatched, so no compute is ever spent for a
 * user who cannot pay.
 *
 * GUARANTEES:
 *   - NO MUTATION: only `getAccount` + `getFreeMinutesUsed` are read. It never
 *     ensures an account, reserves a hold, or debits anything. A user with no
 *     account row simply reads as balance 0.
 *   - MECHANISM ONLY: like the rest of the public gateway, this module carries
 *     no commercial VALUES. The run-fee rates arrive injected (all-zeros on a
 *     public/self-host gateway) and an UNMETERED deployment (both run-fee rates
 *     0) is always allowed — a self-host pays nothing and is never gated.
 *
 * ESTIMATE COMPOSITION (US cents):
 *   managed: invocationFeeCents + first activeMinuteRateCents
 *            + managedInferenceFloorCents   (inference is debited from credits,
 *              so we require a small floor of headroom for the first tokens)
 *   byo:     invocationFeeCents + first activeMinuteRateCents
 *            (only OUR run fees — the user's own provider's acceptance is
 *             unknowable, so we never estimate their inference)
 *
 * FREE TIER: the monthly free active-minute allowance counts toward
 * affordability. Per maintainer policy a user with free active-minutes
 * REMAINING this month is ALLOWED even at zero balance — the free tier must let
 * a new user fire runs; the run-level billing gate still governs actual spend.
 */

import type { CreditLedgerRepository } from "../ports.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default managed-mode inference floor, in US cents: the small credit headroom
 * a MANAGED run must be able to afford beyond the run fees, since managed
 * inference tokens are debited from the same prepaid balance. This is a
 * mechanism-neutral public default (NOT a commercial value) — operators tune it
 * via GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS (see
 * `resolveManagedInferenceFloorCents`).
 */
export const MANAGED_INFERENCE_FLOOR_CENTS = 5;

/** Env var overriding MANAGED_INFERENCE_FLOOR_CENTS (non-negative integer). */
export const MANAGED_INFERENCE_FLOOR_ENV_VAR = "GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS";

/**
 * Resolves the managed inference floor: MANAGED_INFERENCE_FLOOR_CENTS unless
 * GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS is a valid non-negative integer.
 * Mirrors the GATEWAY_MARKUP_BPS override pattern (invalid → default).
 */
export function resolveManagedInferenceFloorCents(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[MANAGED_INFERENCE_FLOOR_ENV_VAR];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return MANAGED_INFERENCE_FLOOR_CENTS;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Billing mode of the prospective run (mirrors contracts' InferenceMode). */
export type RunBillingMode = "managed" | "byo";

/**
 * The Auto v2 run-fee rates the estimate is composed from. Structurally
 * identical to the entrypoint `AutoV2PricingShape` — the VALUES are injected by
 * the hosted composition; a public/self-host gateway sees all-zeros.
 */
export interface RunStartPricing {
  /** Flat per-run invocation fee in US cents. */
  invocationFeeCents: number;
  /** Per-active-minute rate in US cents. */
  activeMinuteRateCents: number;
  /** Per-user, per-calendar-month free active-minute allowance. */
  freeActiveMinutesPerMonth: number;
}

/** Dependencies for `checkAffordability`. Only the two READ methods are used. */
export interface CheckAffordabilityDeps {
  ledger: Pick<CreditLedgerRepository, "getAccount" | "getFreeMinutesUsed">;
  pricing: RunStartPricing;
  /** Managed inference floor override; defaults to MANAGED_INFERENCE_FLOOR_CENTS. */
  managedInferenceFloorCents?: number;
}

/** One affordability question: can `userId` start a `mode` run right now? */
export interface CheckAffordabilityInput {
  userId: string;
  mode: RunBillingMode;
  /**
   * OPTIONAL estimate override in US cents (in-process callers only; the HTTP
   * seam always lets the gateway compose the estimate). When set it replaces
   * the composed estimate — free-tier and unmetered handling still apply.
   */
  estimateCents?: number;
  /** ISO timestamp "now" — selects the UTC month for the free-minute read. */
  now: string;
}

/** The verdict. `reason` is set only when `allowed` is false. */
export interface AffordabilityVerdict {
  allowed: boolean;
  reason?: "insufficient_funds";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The UTC calendar-month key ("YYYY-MM") for an ISO timestamp — MUST match the
 * key the run-driver's free-minute depletion uses so the pre-check reads the
 * SAME month row.
 */
export function utcYearMonth(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Composes the run-start estimate, in US cents:
 *
 *   estimate = invocationFeeCents
 *            + (freeMinutesRemaining > 0 ? 0 : activeMinuteRateCents)
 *            + (mode === "managed" ? managedInferenceFloorCents : 0)
 *
 * With BOTH run-fee rates 0 (unmetered public/self-host deployment) the
 * estimate is 0 regardless of mode — the inference floor only applies where
 * run metering is active, so a self-host is never gated.
 */
export function estimateRunStartCents(
  mode: RunBillingMode,
  pricing: RunStartPricing,
  managedInferenceFloorCents: number = MANAGED_INFERENCE_FLOOR_CENTS,
  freeMinutesRemaining = 0,
): number {
  const invocation = Math.max(0, pricing.invocationFeeCents);
  const activeMinute = Math.max(0, pricing.activeMinuteRateCents);
  if (invocation === 0 && activeMinute === 0) return 0; // unmetered → no gate
  const firstMinute = freeMinutesRemaining > 0 ? 0 : activeMinute;
  const floor = mode === "managed" ? Math.max(0, managedInferenceFloorCents) : 0;
  return invocation + firstMinute + floor;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * READ-ONLY affordability verdict for starting one run. Never mutates the
 * ledger (no ensureAccount / hold / debit). Ledger read failures are NOT
 * caught here — they bubble to the caller, whose transport maps them to the
 * contracts' `ledger_unavailable` (fail-closed for managed, open for BYO).
 */
export async function checkAffordability(
  deps: CheckAffordabilityDeps,
  input: CheckAffordabilityInput,
): Promise<AffordabilityVerdict> {
  const { pricing } = deps;
  const floor = deps.managedInferenceFloorCents ?? MANAGED_INFERENCE_FLOOR_CENTS;

  const metered =
    Math.max(0, pricing.invocationFeeCents) > 0 ||
    Math.max(0, pricing.activeMinuteRateCents) > 0;
  const override = input.estimateCents !== undefined ? Math.max(0, input.estimateCents) : undefined;

  // Unmetered deployment (self-host / public gateway) with no explicit
  // estimate: nothing to afford. No ledger reads at all.
  if (!metered && (override === undefined || override === 0)) {
    return { allowed: true };
  }

  // Free tier: remaining free active-minutes this UTC month count toward
  // affordability. POLICY: any remaining allowance → allowed, even at zero
  // balance (the free tier must admit new users; the run-level billing gate
  // still governs actual spend).
  const allowance = Math.max(0, pricing.freeActiveMinutesPerMonth);
  if (allowance > 0) {
    const used = await deps.ledger.getFreeMinutesUsed(input.userId, utcYearMonth(input.now));
    const freeMinutesRemaining = Math.max(0, allowance - used);
    if (freeMinutesRemaining > 0) {
      return { allowed: true };
    }
  }

  const requiredCents =
    override ?? estimateRunStartCents(input.mode, pricing, floor, 0);
  if (requiredCents === 0) return { allowed: true };

  const account = await deps.ledger.getAccount(input.userId);
  const balanceCents = account?.availableBalanceCents ?? 0;
  if (balanceCents >= requiredCents) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "insufficient_funds",
    detail: `run start requires ${requiredCents}c (${input.mode}); available balance is ${balanceCents}c`,
  };
}
