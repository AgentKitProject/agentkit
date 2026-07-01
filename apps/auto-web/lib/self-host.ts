// Self-host vs hosted-SaaS configuration — the single source of truth for which
// ecosystem integrations are active on a given AgentKitAuto instance. Ported from
// agentkitforge-web/lib/self-host.ts (same signal + helpers) and adapted for Auto.
//
// SELF-HOST SIGNAL:
//   - SELF_HOST=true       — the explicit, sole signal that this instance is
//                            self-hosted. OIDC is just an auth mechanism usable by
//                            BOTH hosted and self-host, so AUTH_PROVIDER=oidc alone
//                            does NOT imply self-host (the hosted SaaS may run OIDC).
//
// HOSTED (the default — AUTH_PROVIDER unset/`workos` and SELF_HOST unset) behaves
// EXACTLY as before: it may reach the hosted Market (protected-kit resolution),
// runs MANAGED prepaid-credit inference with the platform key + AUTO_MARKUP_BPS,
// and links into *.agentkitproject.com.
//
// MARKET on self-host: a self-host instance may run NO Market (DISABLE_MARKET or
// simply no AGENTKITMARKET_BASE_URL) OR point AGENTKITMARKET_BASE_URL at its OWN
// Market. We NEVER fall back to the hosted Market on self-host — that would be a
// silent phone-home.
//
// BILLING on self-host: managed prepaid-credit inference is OFF (BYO key only).
// AUTO_SELFHOST_BILLING defaults to "free" → every run is BYO against the
// operator's ANTHROPIC_API_KEY with auto-core's inert free credit ledger (no
// DynamoDB ledger). A self-hoster who wants metered/managed billing must opt in
// with AUTO_SELFHOST_BILLING=managed (then they supply the selfhost Postgres
// ledger via the k8s worker). See server/core/auto.ts.
//
// Everything here reads `process.env` at call time (never baked at build) and is
// pure/serializable, so it can be resolved on the server and handed to the client
// as `PublicConfig`.

import type { AiProviderType } from "@agentkitforge/gateway-core";

type Env = Record<string, string | undefined>;

const HOSTED_MARKET_BASE_URL = "https://market.agentkitproject.com";

/** The five supported AI provider types (mirrors gateway-core's AiProviderType).
 *  Used to validate the ALLOWED_PROVIDERS provider-lock env. */
const ALL_AI_PROVIDER_TYPES: readonly AiProviderType[] = [
  "anthropic",
  "openai",
  "openai-compatible",
  "gemini",
  "ollama"
] as const;

/**
 * Provider-lock (self-host admin policy). Reads ALLOWED_PROVIDERS (comma-separated,
 * e.g. "anthropic,openai") and returns the validated subset of the five provider
 * types an operator permits. Semantics (IDENTICAL to forge-web's policy):
 *
 *   - unset / empty / whitespace-only        → null (UNRESTRICTED — any provider).
 *   - otherwise                              → the parsed, de-duped subset of the
 *     five known types. Unknown tokens are dropped. If EVERY token is unknown the
 *     result is an EMPTY array (no provider allowed — a strict lock-down), which
 *     is distinct from `null` (unrestricted).
 *
 * Case-insensitive; surrounding whitespace per token is trimmed. The settings
 * store gates saveProvider() against this; the settings UI hides disallowed
 * options via the `allowedProviders` PublicConfig field.
 */
export function getAllowedProviders(env: Env = process.env): AiProviderType[] | null {
  const raw = env.ALLOWED_PROVIDERS;
  if (raw === undefined || raw.trim() === "") return null;
  const seen = new Set<AiProviderType>();
  for (const token of raw.split(",")) {
    const t = token.trim().toLowerCase();
    if (t === "") continue;
    const match = ALL_AI_PROVIDER_TYPES.find((p) => p === t);
    if (match) seen.add(match);
  }
  return [...seen];
}

/**
 * Which credit ledger backs a deployment's billing. Decoupled from the
 * self-host signal — chosen by STORAGE BACKEND (KITSTORE_BACKEND) + BILLING MODE
 * (AUTO_SELFHOST_BILLING), mirroring auto-core's worker `buildBackendDeps`:
 *
 *   - "dynamo"   — the AWS/DynamoDB platform ledger (hosted-on-Dynamo, unchanged).
 *   - "postgres" — the self-host Postgres ledger; ALSO the hosted-on-Postgres
 *                  (DOKS) managed path. Selected whenever the storage backend is
 *                  Postgres AND billing mode is "managed", regardless of whether
 *                  the instance is self-host or hosted.
 *   - "free"     — the inert in-memory ledger (BYO key, no metering).
 */
export type CreditLedgerBackend = "dynamo" | "postgres" | "free";

function truthy(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** True when this instance is self-hosted (explicit SELF_HOST only). */
export function isSelfHost(env: Env = process.env): boolean {
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
 * Resolve the AgentKitProfile API base URL for this instance, or `undefined` when
 * Profile is not configured (`PROFILE_API_BASE_URL` unset). Mirrors
 * `getMarketBaseUrl` but with NO hosted default and NO self-host signal coupling:
 * AgentKitProfile is the org system of record (P2), so the org-key / run-budget
 * resolvers call it directly. On self-host, orgs now REQUIRE Profile — if unset,
 * those resolvers simply fail open (no org key / budget), never phoning home.
 */
export function getProfileBaseUrl(env: Env = process.env): string | undefined {
  return trimmed(env.PROFILE_API_BASE_URL);
}

/** True when AgentKitProfile integration is usable (a base URL is resolvable). */
export function isProfileEnabled(env: Env = process.env): boolean {
  return getProfileBaseUrl(env) !== undefined;
}

/** The storage backend (KITSTORE_BACKEND). "selfhost" → Postgres; everything
 *  else (aws/local/unset) → the DynamoDB-backed AWS adapter. Mirrors
 *  server/core/auto.ts `autoBackend()` and auto-core's worker selector. */
function isPostgresBackend(env: Env): boolean {
  return (env.KITSTORE_BACKEND ?? "local").trim().toLowerCase() === "selfhost";
}

/**
 * The deployment-wide BILLING MODE — independent of the storage backend and of
 * the self-host signal.
 *
 *   - HOSTED (not self-host): always "managed" (platform-key, prepaid credits) —
 *     AUTO_SELFHOST_BILLING is a self-host knob and is ignored here, unchanged.
 *   - SELF-HOST: AUTO_SELFHOST_BILLING (default "free": BYO key, no metering;
 *     "managed": operator opt-in to metered/credit billing).
 *
 * "managed" means metered inference through a credit ledger; "free" means BYO
 * key with the inert free ledger. WHICH credit ledger backs managed billing
 * (Dynamo vs Postgres) is decided separately by `creditLedgerBackend`.
 */
function isManagedBilling(env: Env): boolean {
  if (!isSelfHost(env)) return true;
  return (env.AUTO_SELFHOST_BILLING ?? "free").trim().toLowerCase() === "managed";
}

/**
 * Selects the active credit-ledger backend from STORAGE BACKEND + BILLING MODE,
 * decoupled from the self-host signal (matches auto-core's worker
 * `buildBackendDeps`):
 *
 *   - "free"     — billing mode is free/BYO (self-host default). No metering.
 *   - "postgres" — managed billing on the Postgres backend
 *                  (KITSTORE_BACKEND=selfhost). This covers BOTH self-host
 *                  managed billing AND the NEW hosted-on-Postgres (DOKS) managed
 *                  path (SELF_HOST=false + KITSTORE_BACKEND=selfhost +
 *                  AUTO_SELFHOST_BILLING=managed).
 *   - "dynamo"   — managed billing on the AWS backend (hosted-on-Dynamo,
 *                  unchanged).
 */
export function creditLedgerBackend(env: Env = process.env): CreditLedgerBackend {
  if (!isManagedBilling(env)) return "free";
  return isPostgresBackend(env) ? "postgres" : "dynamo";
}

/**
 * True when MANAGED (platform-key + prepaid-credit) inference is available.
 * Driven by the BILLING MODE, NOT by the storage backend or the self-host flag:
 * free/BYO deployments (self-host default) are off; managed deployments are on
 * (whether they bill via Dynamo or Postgres). Hosted stays on; self-host BYO
 * stays off. Additionally gated by ANTHROPIC_API_KEY in the provider factory,
 * unchanged.
 */
export function isManagedInferenceEnabled(env: Env = process.env): boolean {
  return isManagedBilling(env);
}

/**
 * The self-host managed-billing opt-in. True only on a self-host instance that
 * set AUTO_SELFHOST_BILLING=managed. Hosted always returns false here (hosted is
 * managed via `isManagedInferenceEnabled`, not this self-host-scoped flag).
 *
 * NOTE: this remains self-host-scoped for backward compatibility. To ask "does
 * this deployment use the Postgres credit ledger?" — including the hosted-on-
 * Postgres case — use `creditLedgerBackend(env) === "postgres"` instead.
 */
export function isSelfHostManagedBilling(env: Env = process.env): boolean {
  if (!isSelfHost(env)) return false;
  return (env.AUTO_SELFHOST_BILLING ?? "free").trim().toLowerCase() === "managed";
}

/**
 * True when the hosted DynamoDB platform credit ledger is the active billing
 * backend. Now derived from `creditLedgerBackend` so it is correct for every
 * combination: only the AWS/Dynamo managed path uses it. Self-host (free or
 * Postgres-managed) and hosted-on-Postgres do NOT.
 */
export function usesPlatformCreditLedger(env: Env = process.env): boolean {
  return creditLedgerBackend(env) === "dynamo";
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
  /** Docs site. */
  docsUrl?: string;
}

export function getEcosystemLinks(env: Env = process.env): EcosystemLinks {
  if (!isSelfHost(env)) {
    return {
      projectUrl: trimmed(env.NEXT_PUBLIC_PROJECT_URL) ?? "https://agentkitproject.com",
      // Public BROWSER url (not AGENTKITMARKET_BASE_URL, which is the in-cluster
      // service url for server-side calls). Mirrors the other NEXT_PUBLIC_* links.
      marketUrl: trimmed(env.NEXT_PUBLIC_MARKET_URL) ?? "https://market.agentkitproject.com",
      forgeUrl: trimmed(env.NEXT_PUBLIC_FORGE_URL) ?? "https://forge.agentkitproject.com",
      profileUrl: trimmed(env.NEXT_PUBLIC_PROFILE_URL) ?? "https://profile.agentkitproject.com",
      docsUrl: trimmed(env.NEXT_PUBLIC_DOCS_URL) ?? "https://docs.agentkitproject.com"
    };
  }
  // Self-host: only surface links the operator explicitly configures. The Market
  // browser link follows NEXT_PUBLIC_MARKET_URL (public), not the server-side base.
  // Docs always defaults (the single allowed external link even on self-host).
  const market = trimmed(env.NEXT_PUBLIC_MARKET_URL);
  return {
    projectUrl: trimmed(env.NEXT_PUBLIC_PROJECT_URL),
    ...(market ? { marketUrl: market } : {}),
    forgeUrl: trimmed(env.NEXT_PUBLIC_FORGE_URL),
    profileUrl: trimmed(env.NEXT_PUBLIC_PROFILE_URL),
    docsUrl: trimmed(env.NEXT_PUBLIC_DOCS_URL) ?? "https://docs.agentkitproject.com"
  };
}

/**
 * Serializable config snapshot the server page can hand to the client AutoApp.
 * Everything the UI needs to decide what to show/hide and where to link,
 * resolved at request time on the server (so it honors runtime env, not
 * build-time NEXT_PUBLIC_* baking).
 */
export interface PublicConfig {
  selfHost: boolean;
  marketEnabled: boolean;
  managedBilling: boolean;
  /** Provider-lock: the AI provider types this deployment permits, or null when
   *  unrestricted (any provider). The settings UI hides disallowed options. */
  allowedProviders: AiProviderType[] | null;
  links: EcosystemLinks;
}

export function getPublicConfig(env: Env = process.env): PublicConfig {
  return {
    selfHost: isSelfHost(env),
    marketEnabled: isMarketEnabled(env),
    managedBilling: isManagedInferenceEnabled(env),
    allowedProviders: getAllowedProviders(env),
    links: getEcosystemLinks(env)
  };
}
