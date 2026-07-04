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
 * FREE TRIAL: the ONE-TIME lifetime free active-minute trial counts toward
 * affordability. Per maintainer policy a user with trial minutes REMAINING is
 * ALLOWED even at zero balance — the trial must let a new user fire runs (the
 * run-driver mirrors this: invocation waived + grace-shrunk hold). No monthly
 * reset — the allowance is granted once, ever (FREE_TRIAL_PERIOD_KEY).
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
  /** Per-user ONE-TIME lifetime free active-minute trial. Field name kept
   *  for wire/dep compatibility (historical "per month" naming) — there is NO
   *  monthly reset. */
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
   * the composed COMPUTE estimate — free-tier and unmetered handling still
   * apply. The premium royalty (below) is ADDED on top of this override too
   * (the royalty is buyer cost regardless of how compute was estimated).
   */
  estimateCents?: number;
  /**
   * OPTIONAL premium (per-invocation) kit royalty for THIS run, in US cents (M6).
   * ADDED to the compute estimate so a premium run requires balance ≥
   * (compute + royalty) and is refused with a clean 402 BEFORE dispatch — never
   * a mid-run failure. Default 0 → byte-identical to a non-premium run. Applies
   * even when the free trial waives the compute run fees: the royalty is the
   * seller's price, not a platform run fee, so the trial never waives it.
   */
  premiumRoyaltyCents?: number;
  /** ISO timestamp "now" (audit/estimates; the trial read uses the fixed
   *  lifetime key, not a month derived from this). */
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
 * ONE-TIME FREE TRIAL (maintainer 2026-07-03): the free active-minute
 * allowance is a LIFETIME trial, not a recurring monthly grant. All trial
 * reads/depletions use this FIXED period key — the same atomic + per-run
 * idempotent ledger machinery, one row per user, forever. It must NEVER
 * change once shipped (a new key would re-grant every user's trial).
 */
export const FREE_TRIAL_PERIOD_KEY = "trial";

/**
 * The UTC calendar-month key ("YYYY-MM") for an ISO timestamp. NO LONGER used
 * for the free trial (see FREE_TRIAL_PERIOD_KEY) — retained for monthly
 * aggregations like org usage periods.
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
 *            + premiumRoyaltyCents
 *
 * With BOTH run-fee rates 0 (unmetered public/self-host deployment) AND no
 * premium royalty the estimate is 0 regardless of mode — the inference floor
 * only applies where run metering is active, so a self-host is never gated.
 *
 * PREMIUM ROYALTY (M6): a per-invocation kit's seller price is ADDED to the
 * estimate — the buyer must be able to afford (compute + royalty) up front, so
 * the 402 happens BEFORE dispatch, never mid-run. The royalty survives the
 * free trial (the trial waives platform RUN FEES, not the seller's price) and
 * applies even on an otherwise-unmetered deployment where a paid kit is run.
 * Default 0 → this term is inert and the estimate is byte-identical to before.
 */
export function estimateRunStartCents(
  mode: RunBillingMode,
  pricing: RunStartPricing,
  managedInferenceFloorCents: number = MANAGED_INFERENCE_FLOOR_CENTS,
  freeMinutesRemaining = 0,
  premiumRoyaltyCents = 0,
): number {
  const royalty = Math.max(0, premiumRoyaltyCents);
  const invocation = Math.max(0, pricing.invocationFeeCents);
  const activeMinute = Math.max(0, pricing.activeMinuteRateCents);
  // Unmetered run fees: only the (possibly 0) royalty remains. A self-host with
  // no royalty is never gated; a paid kit still owes its seller price.
  if (invocation === 0 && activeMinute === 0) return royalty;
  // TRULY-FREE TRIAL: remaining free minutes waive the invocation fee too
  // (the run-driver mirrors this — no invocation debit + a grace-shrunk hold).
  // The royalty is NOT a run fee, so the trial never waives it.
  const graced = freeMinutesRemaining > 0;
  const firstMinute = graced ? 0 : activeMinute;
  const invocationDue = graced ? 0 : invocation;
  const floor = mode === "managed" ? Math.max(0, managedInferenceFloorCents) : 0;
  return invocationDue + firstMinute + floor + royalty;
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
  // PREMIUM royalty (M6): the seller's per-run price, ADDED to whatever compute
  // estimate we compose. Default 0 → inert (non-premium runs unchanged). The
  // royalty is NOT a platform run fee: neither the unmetered short-circuit nor
  // the free-trial waiver may skip it — a premium run always requires balance
  // ≥ royalty (on top of any compute), so the 402 fires before dispatch.
  const royalty = Math.max(0, input.premiumRoyaltyCents ?? 0);

  const metered =
    Math.max(0, pricing.invocationFeeCents) > 0 ||
    Math.max(0, pricing.activeMinuteRateCents) > 0;
  const override = input.estimateCents !== undefined ? Math.max(0, input.estimateCents) : undefined;

  // Unmetered deployment (self-host / public gateway) with no explicit estimate
  // AND no royalty: nothing to afford. No ledger reads at all. (A paid kit run
  // still carries a royalty here, so it does NOT short-circuit.)
  if (!metered && (override === undefined || override === 0) && royalty === 0) {
    return { allowed: true };
  }

  // ONE-TIME FREE TRIAL: remaining lifetime trial minutes waive the platform
  // RUN FEES. POLICY: any remaining allowance → the compute run fees are free.
  // The royalty (seller price) is NOT waived, so a premium run under the trial
  // still requires balance ≥ royalty.
  let freeMinutesRemaining = 0;
  const allowance = Math.max(0, pricing.freeActiveMinutesPerMonth);
  if (allowance > 0) {
    const used = await deps.ledger.getFreeMinutesUsed(input.userId, FREE_TRIAL_PERIOD_KEY);
    freeMinutesRemaining = Math.max(0, allowance - used);
    // Trial covers the run fees → only the royalty (if any) remains to afford.
    if (freeMinutesRemaining > 0 && royalty === 0) {
      return { allowed: true };
    }
  }

  // Compute estimate: an explicit override (compute-only) or the composed run
  // fees + floor (waived per remaining trial minutes). The royalty rides on top
  // of EITHER via the estimateRunStartCents royalty arg / an explicit add.
  const computeCents =
    override ?? estimateRunStartCents(input.mode, pricing, floor, freeMinutesRemaining);
  const requiredCents = computeCents + royalty;
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
