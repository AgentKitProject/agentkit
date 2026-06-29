// Self-host vs hosted-SaaS configuration — the single source of truth for which
// ecosystem integrations are active on a given Web Forge instance.
//
// SELF-HOST SIGNAL (any of):
//   - AUTH_PROVIDER=oidc   — a generic-OIDC instance is self-hosted by definition
//                            (the WorkOS-bound hosted SaaS always runs `workos`).
//   - SELF_HOST=true       — explicit opt-in for an OIDC-less self-host (e.g. a
//                            company running their own IdP through a proxy).
//
// HOSTED (the default — AUTH_PROVIDER unset/`workos` and SELF_HOST unset) behaves
// EXACTLY as before: it phones home to https://market.agentkitproject.com, runs
// managed prepaid-credit inference, shows the Stripe credits UI, and links into
// *.agentkitproject.com.
//
// MARKET on self-host: a self-host instance may run NO Market (DISABLE_MARKET or
// simply no AGENTKITMARKET_BASE_URL) OR point AGENTKITMARKET_BASE_URL at its OWN
// Market. We NEVER fall back to the hosted Market on self-host — that would be a
// silent phone-home.
//
// Everything here reads `process.env` at call time (never baked at build) and is
// pure/serializable, so it can be resolved on the server and handed to the client
// as `PublicConfig`.

type Env = Record<string, string | undefined>;

const HOSTED_MARKET_BASE_URL = "https://market.agentkitproject.com";

/**
 * The 5 AI provider types Web Forge supports. Mirrors core's `AiProviderType`
 * (and the contracts `OrgKeyProviderType`) — kept inline so this pure config
 * module stays dependency-free and serializable for the client `PublicConfig`.
 */
export type AiProviderType = "anthropic" | "openai" | "gemini" | "ollama" | "openai-compatible";

const ALL_PROVIDER_TYPES: readonly AiProviderType[] = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "openai-compatible"
];

function isAiProviderType(value: string): value is AiProviderType {
  return (ALL_PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Self-host admin PROVIDER-LOCK policy. Reads `ALLOWED_PROVIDERS` (comma-separated
 * list of provider types). Unset/empty ⇒ `null` (unrestricted — all providers
 * allowed). Otherwise returns the validated subset of the 5 `AiProviderType`
 * values (unknown tokens are dropped). An operator who restricts to a subset
 * blocks users from configuring any other provider type (enforced in the
 * settings store) and hides them from the AI-provider settings UI.
 *
 * EXACT semantics intentionally match auto-web's identical policy.
 */
export function getAllowedProviders(env: Env = process.env): AiProviderType[] | null {
  const raw = trimmed(env.ALLOWED_PROVIDERS);
  if (!raw) return null;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .filter(isAiProviderType);
  // De-duplicate while preserving order.
  const allowed = Array.from(new Set(parsed));
  return allowed.length > 0 ? allowed : null;
}

/** True when `providerType` is permitted by the provider-lock policy. */
export function isProviderAllowed(providerType: string, env: Env = process.env): boolean {
  const allowed = getAllowedProviders(env);
  return allowed === null || (allowed as string[]).includes(providerType);
}

function truthy(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** True when this instance is self-hosted (OIDC auth OR explicit SELF_HOST). */
export function isSelfHost(env: Env = process.env): boolean {
  if ((env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "oidc") return true;
  return truthy(env.SELF_HOST);
}

/**
 * Resolve the Market base URL for this instance, or `undefined` when Market is
 * disabled / not configured.
 *
 *   HOSTED:    configured AGENTKITMARKET_BASE_URL, else the hosted default.
 *   SELF-HOST: configured AGENTKITMARKET_BASE_URL ONLY (point it at your own
 *              Market). No hosted fallback — unset ⇒ Market disabled.
 *
 * `DISABLE_MARKET=true` forces Market off regardless.
 */
export function getMarketBaseUrl(env: Env = process.env): string | undefined {
  if (truthy(env.DISABLE_MARKET)) return undefined;
  const configured = trimmed(env.AGENTKITMARKET_BASE_URL);
  if (configured) return configured;
  // No explicit URL: hosted falls back to the public Market; self-host does not.
  return isSelfHost(env) ? undefined : HOSTED_MARKET_BASE_URL;
}

/** True when Market integration is usable (a base URL is resolvable). */
export function isMarketEnabled(env: Env = process.env): boolean {
  return getMarketBaseUrl(env) !== undefined;
}

/**
 * True when MANAGED (platform-key + prepaid-credit) inference is available.
 * Self-host is BYO-key ONLY — the managed/gateway/credits path is off there.
 * Hosted keeps managed inference (gated additionally by ANTHROPIC_API_KEY in the
 * gateway provider factory, unchanged).
 */
export function isManagedInferenceEnabled(env: Env = process.env): boolean {
  return !isSelfHost(env);
}

/**
 * True when the Stripe credits UI/routes should be shown. Requires BOTH that
 * managed inference is on (not self-host) AND Stripe keys are configured.
 * `isStripeConfigured()` (lib/stripe.ts) is still the authority for the secret
 * key; this adds the self-host gate so credits never surface on self-host.
 */
export function isCreditsUiEnabled(env: Env = process.env): boolean {
  return isManagedInferenceEnabled(env) && trimmed(env.STRIPE_SECRET_KEY) !== undefined;
}

/**
 * Ecosystem link bases. On hosted these are the public *.agentkitproject.com
 * properties (unchanged). On self-host they are configurable via env and OMITTED
 * (undefined) when unset, so the UI hides the link rather than pointing a
 * self-host user back into our ecosystem.
 */
export interface EcosystemLinks {
  /** Marketing/project site (About). */
  projectUrl?: string;
  /** Public Market web app (View on Market, Open Market). */
  marketUrl?: string;
  /** Hosted Forge marketing/download page (About). */
  forgeUrl?: string;
  /** Identity / profile management. */
  profileUrl?: string;
  /** Standalone AgentKitAuto app (nav link-out + legacy ?section=auto redirect). */
  autoUrl?: string;
}

export function getEcosystemLinks(env: Env = process.env): EcosystemLinks {
  if (!isSelfHost(env)) {
    return {
      projectUrl: trimmed(env.NEXT_PUBLIC_PROJECT_URL) ?? "https://agentkitproject.com",
      marketUrl: getMarketBaseUrl(env) ?? "https://market.agentkitproject.com",
      forgeUrl: trimmed(env.NEXT_PUBLIC_FORGE_URL) ?? "https://forge.agentkitproject.com",
      profileUrl: trimmed(env.NEXT_PUBLIC_PROFILE_URL) ?? "https://profile.agentkitproject.com",
      autoUrl: trimmed(env.NEXT_PUBLIC_AUTO_URL) ?? "https://auto.agentkitproject.com"
    };
  }
  // Self-host: only surface links the operator explicitly configures. The Market
  // link follows the configured Market URL (own Market) when present.
  const market = getMarketBaseUrl(env);
  return {
    projectUrl: trimmed(env.NEXT_PUBLIC_PROJECT_URL),
    ...(market ? { marketUrl: market } : {}),
    forgeUrl: trimmed(env.NEXT_PUBLIC_FORGE_URL),
    profileUrl: trimmed(env.NEXT_PUBLIC_PROFILE_URL),
    autoUrl: trimmed(env.NEXT_PUBLIC_AUTO_URL)
  };
}

/**
 * Serializable config snapshot handed from the server page to the client
 * ForgeApp. Everything the UI needs to decide what to show/hide and where to
 * link, resolved at request time on the server (so it honors runtime env, not
 * build-time NEXT_PUBLIC_* baking).
 */
export interface PublicConfig {
  selfHost: boolean;
  marketEnabled: boolean;
  creditsEnabled: boolean;
  links: EcosystemLinks;
  /**
   * Provider-lock policy: the subset of AI provider types the operator permits,
   * or `null` when unrestricted (all allowed). The settings UI hides any provider
   * type not in this list.
   */
  allowedProviders: AiProviderType[] | null;
}

export function getPublicConfig(env: Env = process.env): PublicConfig {
  return {
    selfHost: isSelfHost(env),
    marketEnabled: isMarketEnabled(env),
    creditsEnabled: isCreditsUiEnabled(env),
    links: getEcosystemLinks(env),
    allowedProviders: getAllowedProviders(env)
  };
}
