/**
 * Configuration for the gateway core.
 *
 * `EnvConfigProvider` implements the `ConfigProvider` port over `process.env`.
 * `loadSelfHostConfig` reads the typed configuration the self-host container
 * entrypoint (server) needs: Postgres, Redis (optional), CORS origins, the
 * provider API key for managed mode, and gateway-specific tuning knobs.
 *
 * Pricing constants:
 *   MARKUP_BPS   default 0 (= no token markup). Override via env GATEWAY_MARKUP_BPS.
 *                Auto v2 bills compute per-run (invocation + active-minute) and
 *                passes inference tokens through AT COST, so the default markup is
 *                0. Raise it via GATEWAY_MARKUP_BPS for a deployment that wants a
 *                token margin (e.g. the standalone gateway product).
 *   MIN_TOPUP_CENTS  minimum topup amount (default $5.00 = 500 cents).
 *   PER_CALL_MAX_COST_CENTS  hard per-call cost cap before we refuse (default $1.00 = 100 cents).
 *
 * Session:
 *   SESSION_TTL_SECONDS  default 14400 (4 hours).
 *
 * Cloud-free: this module only reads environment variables; it constructs no
 * SDK clients.
 */

import type { ConfigProvider } from "./ports.js";

// ---------------------------------------------------------------------------
// Pricing / billing constants
// ---------------------------------------------------------------------------

/**
 * Default markup in basis points (1 bps = 0.01%).
 * 0 bps = no token markup (tokens billed AT COST). Override via GATEWAY_MARKUP_BPS.
 *
 * Auto v2 rationale: the platform margin moved off per-token markup onto a
 * RUN-based compute charge (a flat invocation fee + a per-active-minute rate),
 * so managed inference passes through at cost and the default markup is 0. A
 * deployment that wants a token margin sets GATEWAY_MARKUP_BPS (e.g. 1500 = 15%).
 */
export const DEFAULT_MARKUP_BPS = 0;

/** Minimum credit topup in US cents (= $5.00). Prevents micro-transactions. */
export const MIN_TOPUP_CENTS = 500;

/**
 * Hard per-call cost ceiling in US cents (= $1.00).
 * Calls whose max expected cost exceeds this are refused before reserving a hold.
 * Protects against runaway context or misconfigured max_tokens.
 */
export const PER_CALL_MAX_COST_CENTS = 100;

/** Default gateway session TTL in seconds (4 hours). */
export const SESSION_TTL_SECONDS = 4 * 60 * 60;

/**
 * Default model for a managed turn when neither the session nor the kit
 * specifies one. Override via GATEWAY_DEFAULT_MODEL.
 */
export const DEFAULT_GATEWAY_MODEL = "claude-sonnet-4-6";

/**
 * Default max output tokens per provider round-trip when not driven by the
 * session/kit. Override via GATEWAY_MAX_TOKENS.
 */
export const DEFAULT_GATEWAY_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// EnvConfigProvider
// ---------------------------------------------------------------------------

/** ConfigProvider over `process.env`. */
export class EnvConfigProvider implements ConfigProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  get(key: string, required = false): string | undefined {
    const value = this.env[key];
    if (required && (value === undefined || value === "")) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value === "" ? undefined : value;
  }
}

// ---------------------------------------------------------------------------
// Self-host config
// ---------------------------------------------------------------------------

/** Fully-resolved self-host configuration. */
export interface SelfHostGatewayConfig {
  /** Postgres connection string. */
  postgresUrl: string;
  /** Optional Redis URL for rate-limiting / session caching (Phase 1). */
  redisUrl?: string;
  /** Allowed CORS origins; empty → permissive default in dev. */
  allowedOrigins: string[];
  /** Gateway API key gating all gateway routes. */
  gatewayApiKey: string;
  /** HTTP listen port. */
  port: number;
  /** Anthropic API key for managed billing mode. Omit to disable managed mode. */
  anthropicApiKey?: string;
  /** Markup in basis points. Defaults to DEFAULT_MARKUP_BPS. */
  markupBps: number;
  /** Default model when a session/kit does not specify one. */
  defaultModel: string;
  /** Default max output tokens per provider round-trip. */
  maxTokens: number;
  /**
   * Shared service key gating the internal credit-topup endpoint (the Stripe
   * webhook → ledger seam). Server-to-server only, separate from per-user auth.
   * Undefined → the credit-topup endpoint is inert (rejects with 503).
   */
  serviceKey?: string;
}

/**
 * Reads + validates the self-host gateway configuration from a ConfigProvider.
 * Throws on any missing required value so the container fails fast on
 * misconfiguration.
 */
export function loadSelfHostGatewayConfig(config: ConfigProvider): SelfHostGatewayConfig {
  const allowedOrigins = (config.get("API_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const portValue = config.get("PORT");
  const port = portValue ? Number.parseInt(portValue, 10) : 8081;

  const markupRaw = config.get("GATEWAY_MARKUP_BPS");
  const markupBps = markupRaw ? Number.parseInt(markupRaw, 10) : DEFAULT_MARKUP_BPS;

  const maxTokensRaw = config.get("GATEWAY_MAX_TOKENS");
  const maxTokens = maxTokensRaw ? Number.parseInt(maxTokensRaw, 10) : DEFAULT_GATEWAY_MAX_TOKENS;

  return {
    postgresUrl: config.get("DATABASE_URL", true)!,
    redisUrl: config.get("REDIS_URL"),
    allowedOrigins,
    gatewayApiKey: config.get("GATEWAY_API_KEY", true)!,
    port: Number.isFinite(port) ? port : 8081,
    anthropicApiKey: config.get("ANTHROPIC_API_KEY"),
    markupBps: Number.isFinite(markupBps) ? markupBps : DEFAULT_MARKUP_BPS,
    defaultModel: config.get("GATEWAY_DEFAULT_MODEL") ?? DEFAULT_GATEWAY_MODEL,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_GATEWAY_MAX_TOKENS,
    serviceKey: config.get("GATEWAY_SERVICE_KEY"),
  };
}
