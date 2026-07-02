/**
 * L4 concurrency cap — per-user limit on simultaneously ACTIVE runs.
 *
 * A trigger storm (or a scripted caller) must not fan a single user out into
 * unbounded parallel k8s Jobs. This module carries the PURE pieces of that cap:
 * which run statuses count as "active", the default per-user limit (an
 * env-overridable mechanism default, like the other public limits), the
 * `checkConcurrency` verdict helper, and a `countActiveRuns` read that prefers
 * a repository's native count and falls back to a `listRunsByUser` scan.
 *
 * ENFORCEMENT lives with the caller (the trigger/consume path checks the count
 * BEFORE dispatch); nothing here mutates any store.
 */

import type { AutoRunRepository } from "./ports.js";
import type { AutoRun, AutoRunStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default maximum number of ACTIVE (queued/running) runs one user may have at
 * once. A mechanism default (not a commercial value); operators tune it via
 * AUTO_MAX_CONCURRENT_RUNS (see `resolveMaxConcurrentRuns`).
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 5;

/** Env var overriding DEFAULT_MAX_CONCURRENT_RUNS (integer >= 1). */
export const MAX_CONCURRENT_RUNS_ENV_VAR = "AUTO_MAX_CONCURRENT_RUNS";

/** The run statuses that count toward the concurrency cap. Terminal statuses
 *  (succeeded/failed/canceled/budget_exceeded) never do. */
export const ACTIVE_RUN_STATUSES: readonly AutoRunStatus[] = ["queued", "running"];

/** True when `status` counts toward the per-user concurrency cap. */
export function isActiveRunStatus(status: AutoRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * Resolves the per-user cap: DEFAULT_MAX_CONCURRENT_RUNS unless
 * AUTO_MAX_CONCURRENT_RUNS is a valid integer >= 1 (mirrors the other
 * env-overridable limits: an invalid value falls back to the default).
 */
export function resolveMaxConcurrentRuns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_CONCURRENT_RUNS_ENV_VAR];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

// ---------------------------------------------------------------------------
// The check (pure)
// ---------------------------------------------------------------------------

/** The concurrency verdict. `reason` is set only when `allowed` is false. */
export interface ConcurrencyVerdict {
  allowed: boolean;
  reason?: "concurrency_limit";
  detail?: string;
}

/**
 * Pure cap check: allowed while the user's ACTIVE run count is strictly below
 * the cap (starting one more would not exceed it). Negative inputs are treated
 * as 0; a cap below 1 is clamped to 1 (a cap that admits nothing would wedge
 * every trigger, so the floor is "one run at a time").
 */
export function checkConcurrency(input: { active: number; max: number }): ConcurrencyVerdict {
  const active = Math.max(0, input.active);
  const max = Math.max(1, input.max);
  if (active < max) return { allowed: true };
  return {
    allowed: false,
    reason: "concurrency_limit",
    detail: `user has ${active} active run(s); the limit is ${max}`,
  };
}

// ---------------------------------------------------------------------------
// Active-run count (read-only)
// ---------------------------------------------------------------------------

/**
 * How many recent rows the listRunsByUser fallback scans. Active runs are by
 * nature recent (newest-first ordering), so this comfortably covers any real
 * cap; a user would need this many newer TERMINAL runs while an older run is
 * still active for the fallback to undercount.
 */
const ACTIVE_COUNT_SCAN_LIMIT = 200;

/**
 * Counts the user's ACTIVE (queued/running) runs. Prefers the repository's
 * native `countActiveRuns` (implemented by the pg + dynamo adapters); falls
 * back to filtering a newest-first `listRunsByUser` page for repositories
 * (including test fakes) that only carry the base port surface. Read-only.
 */
export async function countActiveRuns(
  runs: Pick<AutoRunRepository, "listRunsByUser" | "countActiveRuns">,
  userId: string,
  opts: { scanLimit?: number } = {},
): Promise<number> {
  if (typeof runs.countActiveRuns === "function") {
    return runs.countActiveRuns(userId);
  }
  const recent = await runs.listRunsByUser(userId, opts.scanLimit ?? ACTIVE_COUNT_SCAN_LIMIT);
  return recent.filter((run: AutoRun) => isActiveRunStatus(run.status)).length;
}
