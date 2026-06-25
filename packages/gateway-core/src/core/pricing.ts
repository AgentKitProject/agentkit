/**
 * Pure pricing / metering service for the inference gateway.
 *
 * All functions are pure (no I/O, no side effects) so they can be unit-tested
 * without any infrastructure. The computation is:
 *
 *   debitCents = ceil(
 *     ( inputCost + outputCost + cachedReadCost + cachedWriteCost )
 *     * (1 + markupBps / 10_000)
 *   )
 *
 * Token prices are in USD per million tokens (per Anthropic's public pricing
 * page). Cached-read tokens are priced at 10% of the input rate. Cache-write
 * tokens are priced at 125% of the input rate (Anthropic's cache-write premium).
 *
 * IMPORTANT: This table must be kept in sync with Anthropic's published pricing.
 * See https://anthropic.com/pricing. The price table is intentionally small —
 * add rows as new models are needed. Unknown models fall back to a safe
 * "unknown" entry priced at Sonnet rates (conservative overshoot rather than
 * under-charge).
 *
 * All amounts are returned as integer US cents (rounded up to the nearest cent).
 */

// ---------------------------------------------------------------------------
// Price table
// ---------------------------------------------------------------------------

/** Per-model token pricing in USD per 1,000,000 tokens. */
export interface ModelPricing {
  /** Input tokens ($/1M). */
  inputPerMillion: number;
  /** Output tokens ($/1M). */
  outputPerMillion: number;
  /**
   * Cache-read tokens ($/1M). Typically 10% of input.
   * If undefined, falls back to inputPerMillion * 0.1.
   */
  cachedReadPerMillion?: number;
  /**
   * Cache-write tokens ($/1M). Typically 125% of input.
   * If undefined, falls back to inputPerMillion * 1.25.
   */
  cachedWritePerMillion?: number;
}

/**
 * Static price table indexed by canonical model id.
 * Prices from Anthropic public pricing page (2026-06).
 *
 * Pattern for aliases: add the alias pointing to the same prices.
 */
const PRICE_TABLE: Record<string, ModelPricing> = {
  // --- Current Claude alias family (use alias form; no date suffixes) ---
  "claude-haiku-4-5": {
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
  },
  "claude-opus-4-8": {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
  },
  "claude-fable-5": {
    inputPerMillion: 10.0,
    outputPerMillion: 50.0,
  },
  // --- Legacy / kept for historical billing records ---
  "claude-haiku-3-0": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
  },
  // --- Fallback / unknown (Sonnet-rate as conservative overshoot) ---
  _unknown: {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
  },
};

/** Returns the pricing entry for a model, falling back to _unknown. */
export function getModelPricing(model: string): ModelPricing & { knownModel: boolean } {
  // Normalise: strip date suffixes like "-20251015"
  const normalised = model.replace(/-\d{8}$/, "");
  const pricing = PRICE_TABLE[normalised] ?? PRICE_TABLE["_unknown"]!;
  return {
    ...pricing,
    knownModel: normalised in PRICE_TABLE,
  };
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Token usage as reported by the provider (mirrors types.ts TokenUsage but
 * kept local so pricing.ts stays import-free of the rest of core).
 */
export interface UsageForPricing {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
}

/**
 * Compute the debit amount in US cents for a single model call.
 *
 * @param usage      Token usage reported by the provider.
 * @param model      Canonical model id (e.g. "claude-sonnet-4-6").
 * @param markupBps  Markup in basis points (e.g. 1500 = 15%).
 * @returns          Debit amount in integer US cents, rounded UP.
 *
 * Pure function — no side effects, no I/O.
 */
export function computeDebitCents(
  usage: UsageForPricing,
  model: string,
  markupBps: number,
): number {
  const pricing = getModelPricing(model);

  const cachedReadRate =
    pricing.cachedReadPerMillion ?? pricing.inputPerMillion * 0.1;
  const cachedWriteRate =
    pricing.cachedWritePerMillion ?? pricing.inputPerMillion * 1.25;

  // Raw input tokens (exclude cached tokens from the base input rate).
  // Anthropic bills cache-hit tokens at the cached-read rate, NOT the full
  // input rate. cachedWriteTokens are billed at the cache-write rate.
  // Non-cached input tokens = inputTokens - cachedReadTokens - cachedWriteTokens.
  const nonCachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedReadTokens - usage.cachedWriteTokens,
  );

  const rawCostUsd =
    (nonCachedInput * pricing.inputPerMillion) / 1_000_000 +
    (usage.outputTokens * pricing.outputPerMillion) / 1_000_000 +
    (usage.cachedReadTokens * cachedReadRate) / 1_000_000 +
    (usage.cachedWriteTokens * cachedWriteRate) / 1_000_000;

  const withMarkup = rawCostUsd * (1 + markupBps / 10_000);

  // Convert to cents, round UP (ceil) — we never under-charge.
  const cents = Math.ceil(withMarkup * 100);

  // Minimum 1 cent for any non-zero call to avoid free micro-calls.
  const hasUsage =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cachedReadTokens > 0 ||
    usage.cachedWriteTokens > 0;

  return hasUsage ? Math.max(1, cents) : 0;
}

/**
 * Compute the maximum possible debit for a call before it runs, given
 * maxTokens (the worst-case output) and an estimated input size.
 *
 * Used to size the pre-call hold. Conservative: assumes all input tokens
 * are non-cached and all output tokens are consumed.
 *
 * @param estimatedInputTokens  Approximate prompt token count (system + history + user turn).
 * @param maxOutputTokens       maxTokens param passed to the provider.
 * @param model                 Canonical model id.
 * @param markupBps             Markup in basis points.
 * @returns                     Maximum debit in integer US cents, rounded UP.
 */
export function computeMaxHoldCents(
  estimatedInputTokens: number,
  maxOutputTokens: number,
  model: string,
  markupBps: number,
): number {
  return computeDebitCents(
    {
      inputTokens: estimatedInputTokens,
      outputTokens: maxOutputTokens,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    model,
    markupBps,
  );
}
