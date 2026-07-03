/**
 * Poll-cursor helpers shared by the Wave-3b pollers (watch / rss /
 * run_completed).
 *
 * A polled trigger's `cursor` column carries a JSON-serialized resume point
 * (versioned; `polledAt` is the last-poll instant used for interval gating).
 * The pollers follow the runDueScheduleTriggers discipline:
 *
 *   - PERSIST-BEFORE-DISPATCH: the advanced cursor is written BEFORE any event
 *     is consumed, so a crash/re-entrant sweep can never double-fire (a
 *     duplicate fire is worse than a missed one — same trade-off as the
 *     schedule sweep).
 *   - NO HOT-LOOPS: on a poll failure with an EXISTING cursor, `polledAt` is
 *     still advanced (the source is retried next interval, not next sweep).
 *     With NO cursor yet (baseline never succeeded) nothing is persisted —
 *     a null baseline cursor must never be fabricated, because an empty
 *     baseline would fire an event storm for every pre-existing item on the
 *     first successful poll. The circuit breaker bounds the retries instead.
 *   - MALFORMED CURSOR = BASELINE: an unparseable cursor re-baselines (no
 *     dupes: baselining emits no events).
 */

import type { ConsumeTriggerEventDeps } from "./trigger-runner.js";
import { CIRCUIT_PAUSE_AFTER_CONSECUTIVE } from "./trigger-runner.js";

/** Fields every poll cursor carries (see the per-poller extensions). */
export interface PollCursorBase {
  /** Cursor format version. */
  v: 1;
  /** ISO of the last completed poll attempt — the interval-gate clock. */
  polledAt: string;
}

/**
 * Parses a trigger's persisted poll cursor. Returns null for absent OR
 * malformed cursors — both mean "first sweep" (baseline; emits no events, so
 * re-baselining after corruption can never duplicate fires).
 */
export function parsePollCursor<T extends PollCursorBase>(
  cursor: string | null | undefined,
): T | null {
  if (cursor === null || cursor === undefined || cursor.length === 0) return null;
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { polledAt?: unknown }).polledAt === "string"
    ) {
      return parsed as T;
    }
  } catch {
    /* malformed → baseline */
  }
  return null;
}

/** True when the trigger is due for a poll: no cursor yet, or the interval
 *  has elapsed since `polledAt`. An unparseable polledAt counts as due. */
export function isPollDue(
  cursor: PollCursorBase | null,
  intervalMinutes: number,
  nowISO: string,
): boolean {
  if (cursor === null) return true;
  const last = Date.parse(cursor.polledAt);
  if (Number.isNaN(last)) return true;
  return last + intervalMinutes * 60_000 <= Date.parse(nowISO);
}

/**
 * Records a POLL-LEVEL failure (bad connection, unreachable feed, list error):
 * an "error" fire-log row + a circuit failure (pausing at the threshold),
 * mirroring consumeTriggerEvent's error path. Best-effort — never throws.
 */
export async function recordPollFailure(
  deps: ConsumeTriggerEventDeps,
  triggerId: string,
  at: string,
  detail: string,
): Promise<void> {
  try {
    await deps.fireLogs.appendFireLog({
      triggerId,
      at,
      outcome: "error",
      runId: null,
      detail,
    });
  } catch {
    /* best-effort */
  }
  try {
    const failures = await deps.triggers.recordCircuitFailure(triggerId);
    if (failures >= CIRCUIT_PAUSE_AFTER_CONSECUTIVE) {
      await deps.triggers.setCircuitPaused(triggerId, at);
    }
  } catch {
    /* best-effort */
  }
}
