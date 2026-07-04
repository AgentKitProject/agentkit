/**
 * M6 #5 — durable royalty-accrual RECONCILIATION job wrapper (binds real deps to
 * the DI core).
 *
 * A PREMIUM (per-invocation) run charges the BUYER their royalty, then accrues it
 * to the SELLING org via the gateway ledger. That accrual is best-effort: if it
 * throws, the buyer is charged but the seller is not yet credited, and the worker
 * records a durable "unaccrued royalty" intent in the Auto Postgres
 * (`auto_unaccrued_royalties`). This job re-drives those intents through the SAME
 * idempotent gateway `accrueRoyalty` (source_ref = runId) — so buyer-charge and
 * seller-accrue eventually reconcile with no double-credit.
 *
 * It exposes two entry points:
 *   1. `runRoyaltyReconciliation(opts?)` — a cron-invocable function returning the
 *      structured ReconcileRoyaltiesResult. Call from a scheduled job / CLI / cron.
 *   2. `serviceRunRoyaltyReconciliation(request)` — a SERVICE-KEY-gated route
 *      handler (`POST /api/internal/auto/reconcile-royalties`) that runs the same
 *      job and returns the result as JSON. This is an operational / cron endpoint
 *      (a headless k8s CronJob calls it with AUTO_WORKER_SERVICE_KEY), so it uses
 *      the SAME service-key gate as /api/internal/auto/sweep + /resolve-context —
 *      NOT the AuthKit cookie helpers and NOT the Forge bearer (CLAUDE.md hard
 *      rule #4). When the key is unset the endpoint is DISABLED (503).
 *
 * INERT until premium royalties exist AND the backend is Postgres + a gateway is
 * configured: on the DynamoDB (local/dev/aws) backend there is no store (empty
 * result); with no gateway `accrueRoyalty` is never reached because there is
 * nothing pending. On open-core / self-host the table exists but is never written,
 * so this is a clean empty result.
 *
 * SAFETY: no real accrual runs in tests or a normal path — the core is tested with
 * a fake store + fake accrue. A real accrual only happens when this runs against
 * real pending rows with the gateway configured.
 */

import { autoErrorCodeSchema, autoInternalServiceKeyHeader } from "@agentkitforge/contracts";
import { timingSafeEqual } from "node:crypto";
import {
  HttpLedgerClient,
  PostgresRoyaltyAccrualStore,
  reconcileRoyaltyAccrualsCore,
  type ReconcileRoyaltiesResult,
} from "@agentkitforge/auto-core";

/** ISO 8601 clock — matches the run path's `now()`. */
function now(): string {
  return new Date().toISOString();
}

/** Empty result (nothing scanned/reconciled) — the inert return when there is no
 *  store (non-Postgres backend) or nothing pending. */
function emptyResult(): ReconcileRoyaltiesResult {
  return { scanned: 0, reconciled: 0, failed: 0, errors: [] };
}

/**
 * Builds the durable royalty-accrual store from the Auto Postgres pool. Present
 * ONLY on the selfhost/Postgres backend (KITSTORE_BACKEND=selfhost) — the
 * DynamoDB (local/dev/aws) backend has no pool and premium royalties are a
 * hosted-on-Postgres concern, so this returns undefined there (→ inert empty
 * result). The Auto schema is ensured idempotently before the store is used.
 */
async function getRoyaltyStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresRoyaltyAccrualStore | undefined> {
  const backend = (env.KITSTORE_BACKEND || "local").toLowerCase();
  if (backend !== "selfhost") return undefined;
  const { getAutoRunPgPool } = await import("@/server/store/selfhost-user-settings");
  const pool = await getAutoRunPgPool();
  const { ensureAutoSchema } = await import("@agentkitforge/auto-core");
  await ensureAutoSchema(pool as never);
  return new PostgresRoyaltyAccrualStore(pool as never);
}

/**
 * Builds the gateway ledger client from the SAME env pair the run-fee / can-start
 * paths use (GATEWAY_INTERNAL_BASE_URL + GATEWAY_SERVICE_KEY). Returns undefined
 * when either is absent — i.e. no gateway, so accrual can't be re-driven.
 */
function getLedgerClient(env: NodeJS.ProcessEnv = process.env): HttpLedgerClient | undefined {
  const baseUrl = env.GATEWAY_INTERNAL_BASE_URL?.trim();
  const serviceKey = env.GATEWAY_SERVICE_KEY?.trim();
  if (!baseUrl || !serviceKey) return undefined;
  return new HttpLedgerClient({ baseUrl, serviceKey });
}

/**
 * Runs one royalty-reconciliation batch with the real dependencies. Safe to
 * re-run (the gateway accrual is idempotent by runId). Returns the structured
 * result. INERT when there is no Postgres store (non-selfhost backend) or no
 * gateway configured → an empty result (nothing pending is re-driven).
 *
 * @param opts.limit override the max intents processed in one run (default 200).
 * @param opts.env   override the env source (default: process.env).
 */
export async function runRoyaltyReconciliation(
  opts: { limit?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ReconcileRoyaltiesResult> {
  const env = opts.env ?? process.env;
  const store = await getRoyaltyStore(env);
  const ledger = getLedgerClient(env);
  // No durable store (non-Postgres backend) OR no gateway to accrue through →
  // nothing to reconcile. Clean empty result (never throws, never charges).
  if (!store || !ledger) return emptyResult();

  return reconcileRoyaltyAccrualsCore({
    store,
    accrueRoyalty: ledger.accrueRoyalty.bind(ledger),
    now,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
}

/** Constant-time compare. timingSafeEqual throws on differing lengths, so we
 *  reject a length mismatch first (the length itself is not the secret). Mirrors
 *  the sweep / resolve-context routes exactly. */
function serviceKeyMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the presented service key from x-service-key OR Authorization: Bearer.
 *  The cron caller may send either. */
function presentedKey(request: Request): string | null {
  const headerKey = request.headers.get(autoInternalServiceKeyHeader);
  if (headerKey && headerKey.length > 0) return headerKey;
  const auth = request.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * SERVICE-KEY-gated route handler: `POST /api/internal/auto/reconcile-royalties`.
 *
 * This is an operational / cron endpoint (like /api/internal/auto/sweep), so it
 * uses the SAME AUTO_WORKER_SERVICE_KEY gate — NOT the AuthKit cookie helpers and
 * NOT the Forge bearer (CLAUDE.md hard rule #4): a headless k8s CronJob presents
 * the service key it was provisioned with (x-service-key OR Authorization: Bearer).
 * When the key is unset the endpoint is DISABLED (503) — it never falls back to
 * unauthenticated access. Accepts an optional JSON body `{ limit?: number }` to
 * bound the batch.
 *
 * SECURITY: never logs the service key; returns only the non-sensitive result.
 */
export async function serviceRunRoyaltyReconciliation(request: Request): Promise<Response> {
  // ---- Service-key gate (THIRD auth path; service key only) ----------------
  const expected = process.env.AUTO_WORKER_SERVICE_KEY;
  if (!expected || expected.length === 0) {
    // Disabled until a key is configured — never allow unauthenticated access.
    return Response.json(
      { error: autoErrorCodeSchema.enum.internal_auth_unconfigured },
      { status: 503 },
    );
  }
  const presented = presentedKey(request);
  if (!presented || !serviceKeyMatches(expected, presented)) {
    return Response.json({ error: autoErrorCodeSchema.enum.unauthorized }, { status: 401 });
  }

  // ---- Run one reconciliation batch ----------------------------------------
  let limit: number | undefined;
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const l = (body as Record<string, unknown>).limit;
      if (typeof l === "number" && Number.isFinite(l) && l > 0) limit = Math.floor(l);
    }
  } catch {
    // No/invalid body → default limit.
  }

  const result = await runRoyaltyReconciliation(limit !== undefined ? { limit } : {});
  return Response.json(result, { status: 200 });
}
