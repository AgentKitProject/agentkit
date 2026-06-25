/**
 * Configuration for the gateway core.
 *
 * `EnvConfigProvider` implements the `ConfigProvider` port over `process.env`.
 * `loadSelfHostConfig` reads the typed configuration the self-host container
 * entrypoint (server) needs: Postgres, Redis (optional), CORS origins, the
 * provider API key for managed mode, and gateway-specific tuning knobs.
 *
 * Pricing constants:
 *   MARKUP_BPS   default 1500 (= 15%). Override via env GATEWAY_MARKUP_BPS.
 *                Sized for break-even on Anthropic pass-through cost + infra.
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
 * 1500 bps = 15%. Override via GATEWAY_MARKUP_BPS env var.
 *
 * Rationale: break-even on Anthropic API cost + S3/DynamoDB infra overhead.
 * Adjust upward if adding Stripe payment-processing fees (~2.9% + 30¢/txn).
 */
export const DEFAULT_MARKUP_BPS = 1500;

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

  return {
    postgresUrl: config.get("DATABASE_URL", true)!,
    redisUrl: config.get("REDIS_URL"),
    allowedOrigins,
    gatewayApiKey: config.get("GATEWAY_API_KEY", true)!,
    port: Number.isFinite(port) ? port : 8081,
    anthropicApiKey: config.get("ANTHROPIC_API_KEY"),
    markupBps: Number.isFinite(markupBps) ? markupBps : DEFAULT_MARKUP_BPS,
  };
}
