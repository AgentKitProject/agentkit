/**
 * run_completed poller (Wave 3b — kit chaining).
 *
 * SEAM CHOICE (documented deliberately): chaining fires from the SWEEP, not
 * the worker. The worker (processAutoRun — Fargate task / k8s Job) stamps the
 * terminal status but has no dispatcher, no billing resolution, and no
 * startRun — creating the NEXT run is an app-server capability. ports.ts
 * already declares run_completed a POLLED type ("every enabled trigger of the
 * type is due each sweep; the poller consults `cursor` itself"), and the sweep
 * endpoint runs identically on hosted (EventBridge→Lambda cron) and self-host
 * (CronJob) — so polling terminal runs from the sweep is the one seam that
 * works everywhere without a new worker→app callback.
 *
 * For each enabled run_completed trigger the sweep scans the owner's recent
 * runs for NEWLY-terminal ones (finishedAt beyond the persisted high-water
 * mark), applies the config match (statuses / kitRef / sourceTriggerId), and
 * feeds one synthesized event per run through the FULL consumeTriggerEvent
 * gate chain.
 *
 * CHAIN-LOOP SAFETY: every chain-fired event carries `chainDepth` = the
 * source run's depth + 1 (a run's depth rides on run.input.event, stamped at
 * create time by the trigger dispatch path). A depth beyond
 * MAX_TRIGGER_CHAIN_DEPTH is REFUSED (an "error" fire-log row, no run, no
 * circuit penalty — the guard working as designed), so A→B→A trigger cycles
 * die after at most MAX_TRIGGER_CHAIN_DEPTH hops. The per-trigger rate cap
 * and circuit breaker apply to chain fires like any other fire.
 *
 * CURSOR (persist-before-dispatch, like every Wave-3b poller): a finishedAt
 * high-water mark + the run ids AT that mark (tie-safe). Baseline first sweep
 * = hwm := now, no events — pre-existing terminal runs never fire a brand-new
 * trigger.
 *
 * S1: the event payload is run METADATA (runId/kitRef/status/summary
 * excerpt/output file PATHS) — output file contents never enter the event.
 */

import type { AutoRunRepository } from "./ports.js";
import type { AutoRun, KitRef, RunCompletedTriggerConfig } from "./types.js";
import {
  consumeTriggerEvent,
  type ConsumeTriggerEventDeps,
  type TriggerSweepSummary,
} from "./trigger-runner.js";
import {
  parsePollCursor,
  recordPollFailure,
  type PollCursorBase,
} from "./poll-cursor.js";

/** Max chain events dispatched per trigger per sweep. */
export const RUN_COMPLETED_MAX_EVENTS_PER_SWEEP = 20;

/** Maximum run_completed chain depth: a chain-fired run may chain again until
 *  its events would carry a depth beyond this — then the fire is refused. */
export const MAX_TRIGGER_CHAIN_DEPTH = 3;

/** How many recent runs one poll scans per trigger owner. */
export const RUN_COMPLETED_SCAN_LIMIT = 200;

/** Max characters of the run summary carried in the event payload (data-sized). */
export const RUN_COMPLETED_SUMMARY_MAX_CHARS = 2000;

/** Terminal statuses (mirrors contracts runTerminalStatusSchema). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "budget_exceeded",
]);

/** The run_completed trigger's persisted cursor: a finishedAt high-water mark
 *  plus the run ids AT that instant (tie-safe dedupe across sweeps). */
export interface RunCompletedCursor extends PollCursorBase {
  hwm: string;
  seen: string[];
}

/** Deps for the run_completed sweep: the consume gate chain + the runs repo. */
export interface RunCompletedPollDeps extends ConsumeTriggerEventDeps {
  runs: AutoRunRepository;
}

/**
 * The chain depth a run was created at: 0 for on-demand/schedule/webhook/
 * watch/rss/event fires, N for a run created by a run_completed chain whose
 * event carried chainDepth N (stamped onto run.input.event by the trigger
 * dispatch path).
 */
export function chainDepthOfRun(run: AutoRun): number {
  const event = run.input?.event;
  if (event !== null && typeof event === "object") {
    const depth = (event as { chainDepth?: unknown }).chainDepth;
    if (typeof depth === "number" && Number.isInteger(depth) && depth > 0) return depth;
  }
  return 0;
}

/** Config kitRef match against a run's kitRef (market: id, else slug; local: id). */
function kitRefMatches(want: KitRef, got: KitRef): boolean {
  if (want.source !== got.source) return false;
  if (want.source === "market") {
    if (want.marketKitId !== undefined && got.marketKitId !== undefined) {
      return want.marketKitId === got.marketKitId;
    }
    return want.slug !== undefined && want.slug === got.slug;
  }
  return want.localKitId !== undefined && want.localKitId === got.localKitId;
}

/**
 * Poll every enabled run_completed trigger once (see the module comment for
 * the seam + cursor discipline). Per-trigger isolation throughout.
 */
export async function runRunCompletedPollSweep(
  deps: RunCompletedPollDeps,
  now: string,
): Promise<TriggerSweepSummary> {
  const summary: TriggerSweepSummary = { processed: 0, dispatched: 0, skipped: 0, errors: [] };

  const due = await deps.triggers.listDue("run_completed", now);

  for (const trigger of due) {
    if (trigger.type !== "run_completed") {
      summary.errors.push({
        triggerId: trigger.id,
        error: "listDue returned a non-run_completed trigger.",
      });
      continue;
    }
    const config: RunCompletedTriggerConfig = trigger.config;
    summary.processed += 1;

    try {
      const cursor = parsePollCursor<RunCompletedCursor>(trigger.cursor);

      // Baseline first sweep: pre-existing terminal runs never fire.
      if (cursor === null) {
        const baseline: RunCompletedCursor = { v: 1, polledAt: now, hwm: now, seen: [] };
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(baseline));
        summary.skipped += 1;
        continue;
      }

      // ---- Newly-terminal runs beyond the high-water mark -------------------
      const runs = await deps.runs.listRunsByUser(trigger.userId, RUN_COMPLETED_SCAN_LIMIT);
      const seen = new Set(cursor.seen);
      const fresh = runs
        .filter(
          (r): r is AutoRun & { finishedAt: string } =>
            TERMINAL_STATUSES.has(r.status) &&
            typeof r.finishedAt === "string" &&
            (r.finishedAt > cursor.hwm || (r.finishedAt === cursor.hwm && !seen.has(r.id))),
        )
        .sort((a, b) =>
          a.finishedAt === b.finishedAt
            ? a.id.localeCompare(b.id)
            : a.finishedAt.localeCompare(b.finishedAt),
        );

      // Walk oldest-first; stop BEFORE the cap+1'th MATCH so undispatched
      // matches stay beyond the persisted mark (no-miss).
      const statuses = config.statuses ?? ["succeeded"];
      const matches: (AutoRun & { finishedAt: string })[] = [];
      let hwm = cursor.hwm;
      let hwmIds = new Set(cursor.seen);
      for (const run of fresh) {
        const isMatch =
          statuses.includes(run.status as (typeof statuses)[number]) &&
          (config.kitRef === null ||
            config.kitRef === undefined ||
            kitRefMatches(config.kitRef, run.kitRef)) &&
          (config.sourceTriggerId === null ||
            config.sourceTriggerId === undefined ||
            run.triggerId === config.sourceTriggerId);
        if (isMatch && matches.length >= RUN_COMPLETED_MAX_EVENTS_PER_SWEEP) break;
        // Acknowledge the run (matching or not) under the advancing mark.
        if (run.finishedAt > hwm) {
          hwm = run.finishedAt;
          hwmIds = new Set([run.id]);
        } else {
          hwmIds.add(run.id);
        }
        if (isMatch) matches.push(run);
      }

      // ---- Advance the cursor (PERSIST BEFORE DISPATCH) ----------------------
      const nextCursor: RunCompletedCursor = {
        v: 1,
        polledAt: now,
        hwm,
        seen: [...hwmIds],
      };
      try {
        await deps.triggers.updateCursor(trigger.id, JSON.stringify(nextCursor));
      } catch (err) {
        summary.errors.push({
          triggerId: trigger.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // cursor not advanced → do NOT dispatch (no-dupe wins).
      }

      if (matches.length === 0) {
        summary.skipped += 1;
        continue;
      }

      // ---- Dispatch through the FULL gate chain ------------------------------
      for (const run of matches) {
        const chainDepth = chainDepthOfRun(run) + 1;
        if (chainDepth > MAX_TRIGGER_CHAIN_DEPTH) {
          // Loop guard working as designed: log, no run, NO circuit penalty.
          try {
            await deps.fireLogs.appendFireLog({
              triggerId: trigger.id,
              at: now,
              outcome: "error",
              runId: null,
              detail: `Chain depth ${chainDepth} exceeds the maximum (${MAX_TRIGGER_CHAIN_DEPTH}) — fire refused (loop guard).`,
            });
          } catch {
            /* best-effort */
          }
          summary.skipped += 1;
          continue;
        }

        const summaryText = run.result?.output;
        const outputPaths = (run.outputFiles ?? []).map((f) => f.path);
        const log = await consumeTriggerEvent(
          trigger,
          {
            name: "run_completed",
            payload: {
              runId: run.id,
              kitRef: run.kitRef,
              status: run.status,
              chainDepth,
              ...(typeof summaryText === "string" && summaryText.length > 0
                ? { summary: summaryText.slice(0, RUN_COMPLETED_SUMMARY_MAX_CHARS) }
                : {}),
              ...(outputPaths.length > 0 ? { outputFiles: outputPaths } : {}),
            },
            receivedAt: now,
            chainDepth,
          },
          deps,
        );
        if (log.outcome === "run_created") summary.dispatched += 1;
        else if (log.outcome === "error") {
          summary.errors.push({ triggerId: trigger.id, error: log.detail ?? "Fire errored." });
        } else summary.skipped += 1;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push({ triggerId: trigger.id, error: detail });
      await recordPollFailure(deps, trigger.id, now, detail);
    }
  }

  return summary;
}
