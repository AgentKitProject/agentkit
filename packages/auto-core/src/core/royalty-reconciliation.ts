/**
 * M6 #5 — durable royalty-accrual RECONCILIATION.
 *
 * A PREMIUM (per-invocation) run charges the BUYER their royalty within the buyer
 * settle, then immediately accrues it to the SELLING org via the gateway ledger
 * (`accrueRoyalty`, idempotent by runId). That accrual is best-effort: if it
 * throws (transient gateway error / restart), the buyer is already charged but the
 * seller is not yet credited. The run-driver flags this (`royaltyAccrued === false`),
 * and the worker records a durable "unaccrued royalty" intent in this store.
 *
 * A periodic reconciliation job (`reconcileRoyaltyAccrualsCore`) re-drives those
 * intents through the SAME idempotent `accrueRoyalty` — so buyer-charge and
 * seller-accrue eventually reconcile with no double-credit (source_ref = runId).
 *
 * OPEN-CORE / SELF-HOST: inert. Nothing records an intent unless a premium royalty
 * was actually charged and its accrual failed; the store + job are only wired on
 * the hosted managed path.
 */

import type { AccrueRoyaltyInput } from "@agentkitforge/gateway-core";

/** A run whose buyer-charged royalty still needs to be accrued to the seller. */
export interface UnaccruedRoyalty {
  /** The run (idempotency key; source_ref = `royalty-${runId}`). */
  runId: string;
  /** The SELLING org that earns the royalty. */
  orgId: string;
  /** The premium kit that was run. */
  kitId: string;
  /** Gross royalty in US cents (the buyer-charged amount, before commission). */
  grossRoyaltyCents: number;
  /** Platform commission in basis points withheld at accrual. */
  commissionBps: number;
}

/**
 * Durable store of royalty accruals the immediate path did not confirm. Backed by
 * the auto app's own Postgres (hosted) — the record write happens in the worker,
 * which already holds a durable connection, so it survives the failed accrual.
 */
export interface RoyaltyAccrualStore {
  /**
   * Record a run whose buyer-charged royalty was NOT accrued. IDEMPOTENT by runId:
   * re-recording the same run does not duplicate or reset it.
   */
  recordUnaccrued(intent: UnaccruedRoyalty, now: string): Promise<void>;
  /** Runs still awaiting accrual (not yet reconciled), oldest first, up to `limit`. */
  listUnaccrued(limit: number): Promise<UnaccruedRoyalty[]>;
  /** Mark a run's royalty accrued (reconciled). IDEMPOTENT. */
  markAccrued(runId: string, now: string): Promise<void>;
  /** Record the latest accrual error for a still-pending run (observability only). */
  markError(runId: string, error: string, now: string): Promise<void>;
}

export interface ReconcileRoyaltiesDeps {
  /** The durable intent store (read + resolve). */
  store: Pick<RoyaltyAccrualStore, "listUnaccrued" | "markAccrued" | "markError">;
  /** The gateway ledger's accrual (idempotent by runId). */
  accrueRoyalty: (input: AccrueRoyaltyInput) => Promise<void>;
  /** Clock — ISO 8601. */
  now: () => string;
  /** Max intents to process in one run (default 200). */
  limit?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface ReconcileRoyaltiesResult {
  scanned: number;
  reconciled: number;
  failed: number;
  errors: Array<{ runId: string; error: string }>;
}

/**
 * Re-drives every pending unaccrued royalty through `accrueRoyalty` (idempotent),
 * marking each resolved on success. A failure on one run is logged + recorded and
 * does NOT abort the batch. Safe to re-run: `accrueRoyalty` is idempotent by runId,
 * so a run whose accrual actually landed on a previous attempt is a no-op here.
 */
export async function reconcileRoyaltyAccrualsCore(
  deps: ReconcileRoyaltiesDeps,
): Promise<ReconcileRoyaltiesResult> {
  const log = deps.logger ?? console;
  const limit = deps.limit ?? 200;

  let pending: UnaccruedRoyalty[];
  try {
    pending = await deps.store.listUnaccrued(limit);
  } catch (err) {
    log.error("[royalty-reconcile] failed to list unaccrued royalties; aborting run.", err);
    return { scanned: 0, reconciled: 0, failed: 0, errors: [] };
  }

  let reconciled = 0;
  let failed = 0;
  const errors: Array<{ runId: string; error: string }> = [];

  for (const intent of pending) {
    try {
      await deps.accrueRoyalty({
        orgId: intent.orgId,
        kitId: intent.kitId,
        runId: intent.runId,
        grossRoyaltyCents: intent.grossRoyaltyCents,
        commissionBps: intent.commissionBps,
        now: deps.now(),
      });
      await deps.store.markAccrued(intent.runId, deps.now());
      reconciled++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ runId: intent.runId, error: message });
      // Best-effort: record the error so a stuck run is visible; never let a
      // record failure abort the batch.
      try {
        await deps.store.markError(intent.runId, message, deps.now());
      } catch {
        /* best-effort */
      }
      log.error(`[royalty-reconcile] run ${intent.runId}: accrual retry failed — ${message}. Continuing.`);
    }
  }

  return { scanned: pending.length, reconciled, failed, errors };
}

/**
 * In-memory reference implementation of RoyaltyAccrualStore — the tested reference
 * (the hosted Postgres store must match) and the open-core / self-host default
 * (inert unless a premium accrual actually fails). recordUnaccrued is idempotent
 * on runId; a resolved (accrued) row drops out of listUnaccrued.
 */
export class InMemoryRoyaltyAccrualStore implements RoyaltyAccrualStore {
  private readonly rows = new Map<
    string,
    UnaccruedRoyalty & { createdAt: string; accruedAt?: string; error?: string }
  >();

  async recordUnaccrued(intent: UnaccruedRoyalty, now: string): Promise<void> {
    if (this.rows.has(intent.runId)) return; // idempotent
    this.rows.set(intent.runId, { ...intent, createdAt: now });
  }

  async listUnaccrued(limit: number): Promise<UnaccruedRoyalty[]> {
    return [...this.rows.values()]
      .filter((r) => r.accruedAt === undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map(({ runId, orgId, kitId, grossRoyaltyCents, commissionBps }) => ({
        runId,
        orgId,
        kitId,
        grossRoyaltyCents,
        commissionBps,
      }));
  }

  async markAccrued(runId: string, now: string): Promise<void> {
    const row = this.rows.get(runId);
    if (row) row.accruedAt = now;
  }

  async markError(runId: string, error: string, now: string): Promise<void> {
    const row = this.rows.get(runId);
    if (row && row.accruedAt === undefined) row.error = error;
  }
}
