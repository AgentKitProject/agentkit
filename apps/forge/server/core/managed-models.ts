// Managed (in-house, prepaid-credit) model catalog for Web Forge.
//
// These are the models the inference gateway can bill for. The ids MUST match a
// row in @agentkitforge/gateway-core's pricing table (src/core/pricing.ts) so
// the credit hold/debit is priced correctly; unknown ids fall back to the
// conservative Sonnet "_unknown" rate. The `tier` is a relative cost hint
// derived from that price table (cheaper / standard / premium).
//
// Shared by the server (default-model resolution, /api/managed/models) and the
// client (managed model selector). Pure data — safe to import on both sides.

export type ManagedModelTier = "cheaper" | "standard" | "premium" | "max";

/** Which managed provider serves a model — used to group the selector and to
 *  mirror gateway-core's `classifyManagedModelProvider` routing. */
export type ManagedModelProvider = "anthropic" | "openai";

export type ManagedModel = {
  /** Canonical model id — must exist in the gateway pricing table. */
  id: string;
  /** Human label for the selector. */
  label: string;
  /** Relative cost hint from the price table. */
  tier: ManagedModelTier;
  /** Provider family that serves this model (Anthropic / OpenAI). */
  provider: ManagedModelProvider;
};

// Ordered cheapest → most capable, grouped by provider (Claude first — the
// managed default lives there). Ids verified against the installed gateway-core
// pricing table (claude-*: haiku-4-5 / sonnet-4-6 / opus-4-8 / fable-5;
// gpt-5.4-nano / gpt-5.4-mini / gpt-5.4 / gpt-5.5). Every id MUST have a
// gateway-core pricing row so managed credit debits are priced correctly, and
// the `provider` MUST agree with gateway-core's classifyManagedModelProvider.
// Keep in sync if the price table gains newer rows.
export const MANAGED_MODELS: ManagedModel[] = [
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5 (fastest, cheapest)", tier: "cheaper",  provider: "anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)",          tier: "standard", provider: "anthropic" },
  { id: "claude-opus-4-8",   label: "Claude Opus 4.8 (advanced)",            tier: "premium",  provider: "anthropic" },
  { id: "claude-fable-5",    label: "Claude Fable 5 (most capable)",         tier: "max",      provider: "anthropic" },
  { id: "gpt-5.4-nano",      label: "GPT-5.4 nano (fastest, cheapest)",      tier: "cheaper",  provider: "openai" },
  { id: "gpt-5.4-mini",      label: "GPT-5.4 mini (fast, low-cost)",         tier: "cheaper",  provider: "openai" },
  { id: "gpt-5.4",           label: "GPT-5.4 (balanced)",                    tier: "standard", provider: "openai" },
  { id: "gpt-5.5",           label: "GPT-5.5 (most capable)",                tier: "premium",  provider: "openai" },
];

// Balanced default used when the caller does not request a model. Must equal
// MANAGED_DEFAULT_MODEL in server/core/ai-draft.ts.
export const MANAGED_DEFAULT_MODEL = "claude-sonnet-4-6";

/** True if `id` is one of the managed models we offer in the selector. */
export function isManagedModel(id: string | undefined): boolean {
  return !!id && MANAGED_MODELS.some((m) => m.id === id);
}
