/**
 * Hosted (managed-billing) gateway composition root.
 *
 * This is the runnable counterpart of the `entrypoints/server.ts` example: it
 * composes the gateway for the HOSTED deployment, where managed turns debit a
 * buyer's prepaid credit balance against the commercial Postgres credit ledger.
 *
 * Open-core seam (mirrors market-core's `entrypoints/server.ts` `loadCommercial`
 * and auto-core's worker `loadManagedLedger`):
 *
 *   - It builds a `pg` Pool from `DATABASE_URL`.
 *   - It OPTIONALLY loads `@agentkit-commercial/gateway` by dynamic import inside
 *     try/catch. Present (the private hosted image) → the managed Postgres credit
 *     ledger + its DDL. Absent (public ghcr / self-host / tests) → the public
 *     `InMemoryCreditLedgerRepository` (free / BYO fallback; no metering).
 *   - At startup, under a `pg_advisory_lock`, it applies the public gateway-core
 *     session schema AND (when the overlay is present) the commercial
 *     `GATEWAY_LEDGER_SCHEMA_SQL`, so concurrent replicas don't race CREATE TABLE.
 *   - It wires the managed turn dependencies: the loaded credit ledger + a
 *     managed Anthropic provider (our platform key) + the Postgres session store.
 *   - It authenticates each caller → `userId` (the router takes a resolved id).
 *
 * NO Stripe / credit-pack flow lives here — that is the separate (real-money,
 * gated) Phase. This module is metering composition only.
 *
 * It does NOT change the public `@agentkitforge/gateway-core` index exports: it
 * is an additive subpath entrypoint, like `entrypoints/server` and
 * `entrypoints/lambda`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import type { ChatProvider, CreditLedgerRepository, SessionStore } from "../core/ports.js";
import type { GatewaySession, ToolDefinition } from "../core/types.js";
import type { ManagedTurnDeps } from "../core/services/managed-turn.js";
import type { CreateGatewaySessionDeps, EntitlementCheck } from "../core/services/gateway-session.js";
import type { StreamingTurnDeps } from "../core/services/streaming-turn.js";
import type { GatewayRouterDeps } from "../core/router.js";
import {
  DEFAULT_GATEWAY_MAX_TOKENS,
  DEFAULT_GATEWAY_MODEL,
  EnvConfigProvider,
  loadSelfHostGatewayConfig,
} from "../core/config.js";
import { InMemoryCreditLedgerRepository } from "../adapters/memory/credit-ledger.js";
import { PostgresSessionStore, type PgPool } from "../adapters/selfhost/postgres.js";
import { createManagedAnthropicProvider } from "../adapters/anthropic/index.js";
import {
  makeObjectStorageKitResolvers,
  type KitPackageStore,
} from "../core/services/kit-context-resolver.js";
import { createGatewayHttpServer, type AuthenticateRequest, type PreRouteHandler } from "./server.js";
import {
  CREDIT_TOPUP_PATH,
  extractServiceKey,
  handleCreditTopup,
  type CreditTopupDeps,
} from "./credit-topup.js";
import { MIN_TOPUP_CENTS } from "../core/config.js";

// Re-export the kit-context resolver surface so a host wiring this entrypoint can
// build / inject an object-storage KitPackageStore from one import (seam #1).
export {
  makeObjectStorageKitResolvers,
  assembleSystemPrompt,
  extractTools,
  DEFAULT_SYSTEM_PROMPT,
} from "../core/services/kit-context-resolver.js";
export type {
  KitPackageStore,
  KitPackageTree,
  KitPackageFile,
  KitContextResolvers,
} from "../core/services/kit-context-resolver.js";

// ---------------------------------------------------------------------------
// Optional commercial overlay surface (typed via the ambient .d.ts; no hard dep)
// ---------------------------------------------------------------------------

interface CommercialGatewayModule {
  createPostgresCreditLedger(pool: PgPool): CreditLedgerRepository;
  GATEWAY_LEDGER_SCHEMA_SQL: string;
}

/** Importer seam so tests can inject a fake overlay or force the absent path. */
export type CommercialImporter = () => Promise<CommercialGatewayModule>;

const defaultCommercialImporter: CommercialImporter = () =>
  import("@agentkit-commercial/gateway") as Promise<CommercialGatewayModule>;

interface LoadedCommercial {
  ledger: CreditLedgerRepository;
  schemaSql: string;
}

/**
 * OPTIONALLY loads the commercial managed Postgres credit ledger + its DDL over
 * a pool. Returns undefined when the package is absent (public / self-host /
 * test), in which case the caller falls back to the in-memory ledger.
 */
export async function loadCommercialLedger(
  pool: PgPool,
  importer: CommercialImporter = defaultCommercialImporter,
): Promise<LoadedCommercial | undefined> {
  try {
    const mod = await importer();
    return {
      ledger: mod.createPostgresCreditLedger(pool),
      schemaSql: mod.GATEWAY_LEDGER_SCHEMA_SQL,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Schema apply (under advisory lock)
// ---------------------------------------------------------------------------

const SCHEMA_LOCK_KEY = 778900; // distinct from market-core's 778899

/** Locates the public session schema.sql whether running from src or dist. */
function readSessionSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/entrypoints → dist/adapters/selfhost/schema.sql
    join(here, "..", "adapters", "selfhost", "schema.sql"),
    // src/entrypoints → src/adapters/selfhost/schema.sql (tsx / vitest)
    join(here, "..", "..", "src", "adapters", "selfhost", "schema.sql"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error("Could not locate gateway-core session schema.sql");
}

/**
 * Applies the public session schema and (when present) the commercial credit-
 * ledger schema under a session-level advisory lock, so only one replica creates
 * the tables while the rest no-op. Mirrors market-core's server startup.
 *
 * `lockPool` must expose `connect()` (a real `pg` Pool does). When it does not
 * (e.g. pg-mem with a single connection) the apply runs without the lock — safe
 * for single-process tests.
 */
export async function applyGatewaySchema(
  pool: SchemaApplyPool,
  ledgerSchemaSql: string | undefined,
): Promise<void> {
  const sessionSql = readSessionSchemaSql();

  const connectable = pool as { connect?: () => Promise<SchemaClient> };
  if (typeof connectable.connect === "function") {
    const client = await connectable.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
      await client.query(sessionSql);
      if (ledgerSchemaSql) await client.query(ledgerSchemaSql);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]).catch(() => {});
      client.release();
    }
    return;
  }

  // No pooled client (single-connection pool / test pool): apply directly.
  await pool.query(sessionSql);
  if (ledgerSchemaSql) await pool.query(ledgerSchemaSql);
}

interface SchemaClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(): void;
}

/** A pool that can apply schema: queryable, optionally with `connect()`. */
export interface SchemaApplyPool extends PgPool {
  connect?: () => Promise<SchemaClient>;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Options for composing the managed gateway dependencies. */
export interface ComposeManagedGatewayOptions {
  /** The Postgres pool (real `pg.Pool` in prod; pg-mem in tests). */
  pool: SchemaApplyPool;
  /** The ChatProvider (managed key). Defaults to the managed Anthropic provider. */
  chatProvider?: ChatProvider;
  /** Markup in basis points. Defaults to the config value (GATEWAY_MARKUP_BPS). */
  markupBps?: number;
  /** Clock. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /**
   * Object-storage backing for server-side kit-context resolution (seam #1).
   * When provided, the system prompt + the kit's tools are read from the kit
   * package keyed by the session's `systemPromptRef` (AWS S3 / DO Spaces) and
   * assembled server-side — so a managed run actually has its kit context.
   *
   * `resolveSystemPrompt` / `resolveTools` below override this when supplied
   * (tests / a host with its own resolution). When NEITHER a store nor explicit
   * resolvers are given, the Phase-1 fallback applies: the system prompt is the
   * stored `systemPromptRef` verbatim and no tools.
   */
  kitPackageStore?: KitPackageStore;
  /**
   * Resolves the secret system prompt for a session (server-side only; never
   * emitted to the client). Overrides `kitPackageStore`. When neither is set the
   * Phase-1 fallback returns the stored `systemPromptRef` verbatim.
   */
  resolveSystemPrompt?: (session: GatewaySession) => Promise<string>;
  /** Resolves the kit's tools for a session. Overrides `kitPackageStore`. */
  resolveTools?: (session: GatewaySession) => Promise<ToolDefinition[]>;
  /** Optional per-session entitlement gate (Tier-3). Defaults to allow-all. */
  entitlementCheck?: EntitlementCheck;
  /** Default model when a session/kit does not specify one. */
  model?: string;
  /** Max output tokens per provider round-trip. */
  maxTokens?: number;
  /** Inject a fake commercial overlay (tests). Defaults to the real importer. */
  commercialImporter?: CommercialImporter;
  /** Skip schema application (tests that manage their own schema). */
  skipSchema?: boolean;
}

/** The composed managed-gateway dependencies. */
export interface ComposedManagedGateway {
  pool: SchemaApplyPool;
  /** The credit ledger backing this deployment (commercial Postgres or in-memory). */
  ledger: CreditLedgerRepository;
  /** True when the commercial overlay was loaded (managed metering active). */
  commercialLoaded: boolean;
  chatProvider: ChatProvider;
  sessions: SessionStore;
  /** Dependencies for the credit-gated non-streaming `runManagedTurn` flow. */
  managedTurnDeps: ManagedTurnDeps;
  /** Full router deps so a host can serve the gateway HTTP contract. */
  routerDeps: Omit<GatewayRouterDeps, "createEmitter">;
}

/**
 * Composes the managed gateway: loads the credit ledger (commercial → Postgres,
 * else in-memory), applies schema under a lock, and wires the managed turn deps
 * + the full router deps. Pure composition — it starts no server.
 */
export async function composeManagedGateway(
  options: ComposeManagedGatewayOptions,
): Promise<ComposedManagedGateway> {
  const now = options.now ?? (() => new Date().toISOString());

  const loaded = await loadCommercialLedger(
    options.pool,
    options.commercialImporter ?? defaultCommercialImporter,
  );
  const ledger = loaded?.ledger ?? new InMemoryCreditLedgerRepository();
  const commercialLoaded = loaded !== undefined;

  if (!options.skipSchema) {
    await applyGatewaySchema(options.pool, loaded?.schemaSql);
  }

  const chatProvider = options.chatProvider ?? createManagedAnthropicProvider();
  const sessions = new PostgresSessionStore(options.pool);

  // Seam #1: server-side kit-context resolution. Explicit resolvers win; else an
  // object-storage store (S3 / Spaces) reads the kit package keyed by the
  // session's systemPromptRef; else the Phase-1 verbatim fallback.
  const storeResolvers = options.kitPackageStore
    ? makeObjectStorageKitResolvers(options.kitPackageStore)
    : undefined;
  const resolveSystemPrompt =
    options.resolveSystemPrompt ??
    storeResolvers?.resolveSystemPrompt ??
    (async (session: GatewaySession) => session.systemPromptRef);
  const resolveTools = options.resolveTools ?? storeResolvers?.resolveTools;

  // Seam #3: default model / maxTokens driven from options → config defaults.
  const model = options.model ?? DEFAULT_GATEWAY_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_GATEWAY_MAX_TOKENS;

  const managedTurnDeps: ManagedTurnDeps = {
    chatProvider,
    ledger,
    now,
    ...(options.markupBps !== undefined ? { markupBps: options.markupBps } : {}),
  };

  const sessionDeps: CreateGatewaySessionDeps = {
    sessions,
    now,
    ...(options.entitlementCheck ? { entitlementCheck: options.entitlementCheck } : {}),
  };

  const turnDeps: StreamingTurnDeps = {
    chatProvider,
    sessions,
    ledger,
    resolveSystemPrompt,
    now,
    model,
    maxTokens,
    ...(options.markupBps !== undefined ? { markupBps: options.markupBps } : {}),
    ...(resolveTools ? { resolveTools } : {}),
  };

  return {
    pool: options.pool,
    ledger,
    commercialLoaded,
    chatProvider,
    sessions,
    managedTurnDeps,
    routerDeps: { session: sessionDeps, turn: turnDeps },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface StartManagedGatewayServerOptions
  extends Omit<ComposeManagedGatewayOptions, "pool"> {
  /** Pre-built pool. When omitted, a `pg.Pool` is built from `DATABASE_URL`. */
  pool?: SchemaApplyPool;
  /** Resolves the authenticated caller's userId. Required for a real deployment. */
  authenticate: AuthenticateRequest;
  /** Listen port. Defaults to the config PORT (8081). */
  port?: number;
  /**
   * Shared service key gating the internal `POST /gateway/credits/topup`
   * endpoint (the Stripe-webhook → ledger seam). Defaults to the config
   * `GATEWAY_SERVICE_KEY`. Undefined/empty → the endpoint is inert (503).
   */
  serviceKey?: string;
  /** Minimum allowed topup in cents. Defaults to MIN_TOPUP_CENTS. */
  minTopupCents?: number;
}

/**
 * Builds the pre-route handler that serves the service-key-gated credit-topup
 * endpoint (`POST /gateway/credits/topup`) before the per-user auth gate. Returns
 * undefined for every other path so the request falls through to the normal
 * authenticated router. Exported for unit testing.
 */
export function makeCreditTopupPreRoute(deps: CreditTopupDeps): PreRouteHandler {
  return async (req, ctx) => {
    if (ctx.path !== CREDIT_TOPUP_PATH) return undefined;
    if (ctx.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    const providedKey = extractServiceKey({
      authorization: req.headers["authorization"],
      serviceKeyHeader: req.headers["x-gateway-service-key"],
    });
    const response = await handleCreditTopup(deps, providedKey, ctx.body);
    return { status: response.status, body: response.body };
  };
}

export interface StartedManagedGateway {
  server: Server;
  composed: ComposedManagedGateway;
  close: () => Promise<void>;
}

/**
 * Builds the pool (from `DATABASE_URL` when not supplied), composes the managed
 * gateway, and starts the node:http server bound to the router.
 *
 * The pool construction uses a lazy `pg` import so this module loads cleanly in
 * environments that inject their own pool (tests, pg-mem).
 */
export async function startManagedGatewayServer(
  options: StartManagedGatewayServerOptions,
): Promise<StartedManagedGateway> {
  const config = loadSelfHostGatewayConfig(new EnvConfigProvider());

  let pool = options.pool;
  let ownsPool = false;
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: config.postgresUrl }) as unknown as SchemaApplyPool;
    ownsPool = true;
  }

  const composeOptions: ComposeManagedGatewayOptions = {
    pool,
    markupBps: options.markupBps ?? config.markupBps,
    // Seam #3: drive default model / maxTokens from the gateway config
    // (GATEWAY_DEFAULT_MODEL / GATEWAY_MAX_TOKENS) when the caller doesn't.
    model: options.model ?? config.defaultModel,
    maxTokens: options.maxTokens ?? config.maxTokens,
    ...stripUndefined({
      chatProvider: options.chatProvider,
      now: options.now,
      kitPackageStore: options.kitPackageStore,
      resolveSystemPrompt: options.resolveSystemPrompt,
      resolveTools: options.resolveTools,
      entitlementCheck: options.entitlementCheck,
      commercialImporter: options.commercialImporter,
      skipSchema: options.skipSchema,
    }),
  };

  const composed = await composeManagedGateway(composeOptions);

  // Internal, service-key-gated credit-topup endpoint (Stripe-webhook → ledger).
  // Reuses the composed credit ledger (commercial Postgres in the hosted image,
  // in-memory otherwise) — the gateway stays the only holder of its DB creds.
  const serviceKey = options.serviceKey ?? config.serviceKey;
  const preRoute = makeCreditTopupPreRoute({
    ledger: composed.ledger,
    serviceKey,
    minCents: options.minTopupCents ?? MIN_TOPUP_CENTS,
    ...(options.now ? { now: options.now } : {}),
  });

  const server = createGatewayHttpServer({
    router: { ...composed.routerDeps, createEmitter: makePlaceholderEmitter },
    authenticate: options.authenticate,
    preRoute,
  });

  const port = options.port ?? config.port;
  await new Promise<void>((resolve) => server.listen(port, resolve));

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (ownsPool) {
      const endable = pool as unknown as { end?: () => Promise<void> };
      if (typeof endable.end === "function") await endable.end();
    }
  };

  return { server, composed, close };
}

/**
 * The createEmitter the node:http server overrides per-request (it builds a real
 * SSE emitter bound to its `res`). This placeholder satisfies the type for
 * composition; `createGatewayHttpServer` replaces it on each request.
 */
function makePlaceholderEmitter() {
  return {
    emit() {
      /* replaced per-request by the http server */
    },
    close() {
      /* replaced per-request by the http server */
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
