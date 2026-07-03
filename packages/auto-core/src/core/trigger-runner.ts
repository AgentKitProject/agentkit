/**
 * The unified trigger consume path (event-driven expansion).
 *
 * `consumeTriggerEvent` GENERALIZES the Phase B schedule-runner and Phase C
 * webhook-runner (both keep working unchanged; they can delegate here in a
 * later app-wiring pass). One event presented to one trigger flows through an
 * ORDERED gate chain — every exit appends a TriggerFireLog row (never a fake
 * run) and, where relevant, updates circuit state:
 *
 *   a. enabled? / circuit paused?  → "suppressed_circuit"
 *   b. declarative filters         → "filtered"        (no circuit penalty)
 *   c. rate cap (maxPerHour)       → "suppressed_rate" (no circuit penalty)
 *   d. affordability (canStartRun) → "skipped_funds"   (+ circuit failure)
 *   e. approval gate               → "error"           (+ circuit failure)
 *   f. buildRunInput → createAndDispatch → "run_created" (+ circuit reset)
 *
 * CIRCUIT BREAKER: insufficient funds, approval-gate failures, and thrown
 * errors increment `circuit.consecutiveFailures`; reaching
 * CIRCUIT_PAUSE_AFTER_CONSECUTIVE pauses the trigger (listDue excludes paused
 * triggers; gate (a) suppresses direct fires). A successful fire resets the
 * counter. Filter/rate exits are NOT failures (they're the trigger working as
 * designed) and a managed-mode ledger OUTAGE (`ledger_unavailable`) skips
 * fail-closed WITHOUT a circuit penalty — an infra outage must not pause every
 * trigger.
 *
 * SAFETY: a trigger never widens consent — gate (e) re-checks the standing
 * approval with the EXACT schedule/webhook-runner semantics (non-revoked
 * approval for (userId, kitRef); budget <= ceiling, 0 = unlimited). S1 holds
 * because the run input comes exclusively from the mapping evaluator.
 *
 * RESILIENCE: consumeTriggerEvent NEVER throws (mirrors the sweep isolation of
 * the schedule-runner); dispatch/persistence errors land as an "error" fire
 * log, best-effort.
 *
 * DETERMINISM: the clock is `event.receivedAt` / the sweep's `now` — never
 * argless Date.
 */

import type {
  AutoApprovalRepository,
  FireLogRepository,
  PendingApprovalRepository,
  TriggerRepository,
} from "./ports.js";
import type {
  AutoRun,
  AutoRunInput,
  CanStartRunRequest,
  CanStartRunResponse,
  InferenceMode,
  PendingTriggerApproval,
  Trigger,
  TriggerFireLog,
  TriggerFireOutcome,
} from "./types.js";
import { CAN_START_FAIL_CLOSED_MODES, PENDING_APPROVAL_TTL_MINUTES } from "./types.js";
import { buildRunInput, evaluateFilters } from "./mapping-evaluator.js";
import { nextFireAfter } from "./cron.js";
import { generateWebhookSecret, hashWebhookSecret } from "./webhook-secret.js";
import type { MessageOrigin } from "./messaging.js";

// ---------------------------------------------------------------------------
// Ports + shapes
// ---------------------------------------------------------------------------

/** Consecutive fire failures after which the circuit breaker pauses a trigger. */
export const CIRCUIT_PAUSE_AFTER_CONSECUTIVE = 10;

/** The rolling rate-limit window (1 hour). */
export const RATE_LIMIT_WINDOW_MS = 3_600_000;

/** How many fire-log rows a rate check fetches (newest-first) to count the
 *  last hour's run_created fires. Generous vs the 500 maxPerHour contract cap. */
const RATE_CHECK_LOG_LIMIT = 1000;

/**
 * The affordability pre-check port: can this user afford to start a run right
 * now? A separate workstream implements it against the gateway ledger; this
 * module only defines the seam (contracts: canStartRunRequest/ResponseSchema).
 */
export type CanStartRun = (req: CanStartRunRequest) => Promise<CanStartRunResponse>;

/** What a trigger fire hands the injected dispatcher: the trigger, the fully
 *  built (S1-safe) run input, and the fire instant. The app layer supplies
 *  server defaults (model/budget) and provenance — same injected-dispatch
 *  pattern as the schedule/webhook runners. */
export interface TriggerRunRequest {
  trigger: Trigger;
  input: AutoRunInput;
  /** ISO of the fire. */
  firedAt: string;
}

/** Injected run-create + dispatch for a trigger fire (kept injected so core
 *  never hard-depends on the app run-create path). */
export type CreateAndDispatchTriggerRun = (req: TriggerRunRequest) => Promise<AutoRun>;

/** One event presented to a trigger. */
export interface TriggerEventInput {
  /** The event name (ingest URL path segment; "schedule" for schedule fires). */
  name: string;
  /** The event payload (data, never instructions — S1). Absent for schedules. */
  payload?: unknown;
  /** ISO of when the event was received — the fire clock. */
  receivedAt: string;
  /**
   * run_completed chain depth (Wave 3b kit-chaining). When present it is
   * stamped onto the created run's input.event so the NEXT chain hop can read
   * it back (chainDepthOfRun) — the loop guard's carrier. Absent for every
   * non-chain fire.
   */
  chainDepth?: number;
  /**
   * Wave 4 message fires: where the message came from. Stamped (metadata,
   * never instructions) onto the created run's input.event.origin so
   * message_reply destinations can post back to the originating
   * channel/thread/chat.
   */
  origin?: MessageOrigin;
  /**
   * Wave 4: this event was ALREADY explicitly approved (a held requireApproval
   * fire being re-presented after an Approve). Skips the hold gate ONLY —
   * every other gate re-runs (S4: fresh gated run per event).
   */
  preApproved?: boolean;
}

/** Dependencies for the trigger consume path (all injected). */
export interface ConsumeTriggerEventDeps {
  triggers: TriggerRepository;
  approvals: AutoApprovalRepository;
  fireLogs: FireLogRepository;
  /** Affordability pre-check (gateway-ledger-backed in the app wiring). */
  canStartRun: CanStartRun;
  /** Creates + dispatches the run for a fire. */
  createAndDispatch: CreateAndDispatchTriggerRun;
  /**
   * Billing mode of prospective runs (threaded to canStartRun; the Trigger
   * record carries no inferenceMode). Defaults to "managed" — the FAIL-CLOSED
   * mode — so an unwired mode can never widen spending.
   */
  inferenceMode?: InferenceMode;
  /**
   * Wave 4: held requireApproval fires. When ABSENT, requireApproval triggers
   * FAIL CLOSED — an "error" fire log, never an unapproved run.
   */
  pendingApprovals?: PendingApprovalRepository;
  /**
   * Wave 4: the approval-prompt sender (app-wired — posts the Approve/Deny
   * message through the trigger's bot connection). Best-effort: a send failure
   * leaves the hold in place (it simply expires unactioned). Receives the ONLY
   * copy of the plaintext one-time token (S2: only its hash is persisted).
   */
  onApprovalRequested?: (
    pending: PendingTriggerApproval,
    plaintextToken: string,
    trigger: Trigger,
    event: TriggerEventInput,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Approval gate (EXACT schedule/webhook-runner semantics)
// ---------------------------------------------------------------------------

/**
 * Re-checks a trigger against the standing approval — the SAME Phase A gate
 * the schedule-runner (`approvalGateSkipReason`) and webhook-runner
 * (`assertApprovalGate`) apply (those helpers are module-private, so the
 * semantics are mirrored verbatim here):
 *   - a non-revoked approval for (userId, kitRef) must exist;
 *   - budget <= approval.maxBudgetCents (a 0 ceiling = unlimited, never blocks).
 * A trigger without an explicit budgetCents defers to the server default at
 * run-create; the ceiling check treats it as 0 (never blocks).
 * Returns a skip reason string, or null when the trigger may fire.
 */
async function approvalGateSkipReason(
  trigger: Trigger,
  approvals: AutoApprovalRepository,
): Promise<string | null> {
  const approval = await approvals.getApprovalForKit(trigger.userId, trigger.kitRef);
  if (!approval) return "No standing approval exists for this kit.";
  if (approval.revokedAt !== null) {
    return "The standing approval for this kit has been revoked.";
  }
  const budgetCents = trigger.budgetCents ?? 0;
  // maxBudgetCents 0 = UNLIMITED (no per-run ceiling) — never blocks.
  if (approval.maxBudgetCents > 0 && budgetCents > approval.maxBudgetCents) {
    return `Trigger budget (${budgetCents}¢) exceeds the approval ceiling (${approval.maxBudgetCents}¢).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// consumeTriggerEvent
// ---------------------------------------------------------------------------

/** ++consecutiveFailures; pause the circuit at the threshold. Best-effort. */
async function recordFailureAndMaybePause(
  deps: ConsumeTriggerEventDeps,
  triggerId: string,
  at: string,
): Promise<void> {
  try {
    const failures = await deps.triggers.recordCircuitFailure(triggerId);
    if (failures >= CIRCUIT_PAUSE_AFTER_CONSECUTIVE) {
      await deps.triggers.setCircuitPaused(triggerId, at);
    }
  } catch {
    // Circuit bookkeeping is best-effort — never masks the fire outcome.
  }
}

/**
 * Present one event to one trigger, walking the ordered gate chain (see the
 * module comment). Returns the appended TriggerFireLog. NEVER throws.
 */
export async function consumeTriggerEvent(
  trigger: Trigger,
  event: TriggerEventInput,
  deps: ConsumeTriggerEventDeps,
): Promise<TriggerFireLog> {
  const at = event.receivedAt;

  const appendLog = (
    outcome: TriggerFireOutcome,
    detail: string | null,
    runId: string | null = null,
  ): Promise<TriggerFireLog> =>
    deps.fireLogs.appendFireLog({ triggerId: trigger.id, at, outcome, runId, detail });

  try {
    // (a) enabled? circuit paused?
    if (!trigger.enabled) {
      return await appendLog("suppressed_circuit", "Trigger is disabled.");
    }
    if (trigger.circuit.pausedAt !== null && trigger.circuit.pausedAt !== undefined) {
      return await appendLog(
        "suppressed_circuit",
        `Circuit breaker is paused (since ${trigger.circuit.pausedAt}).`,
      );
    }

    // (b) declarative filters (no circuit penalty). Schedule fires are the
    // degenerate case — no payload, promptTemplate verbatim — so filters are
    // skipped for type "schedule".
    if (trigger.type !== "schedule" && trigger.filters !== undefined && trigger.filters.length > 0) {
      const verdict = evaluateFilters(trigger.filters, event.payload);
      if (!verdict.pass) {
        const failed = verdict.failedAt !== undefined ? trigger.filters[verdict.failedAt] : undefined;
        const which =
          failed !== undefined
            ? `filter ${verdict.failedAt} (${failed.path} ${failed.op})`
            : "a filter";
        return await appendLog("filtered", `Event did not match ${which}.`);
      }
    }

    // (c) rate cap: run_created fires in the rolling last hour.
    const maxPerHour = trigger.rateLimit.maxPerHour;
    const recent = await deps.fireLogs.listFireLogsByTrigger(trigger.id, RATE_CHECK_LOG_LIMIT);
    const windowStartMs = Date.parse(at) - RATE_LIMIT_WINDOW_MS;
    const firesInWindow = recent.filter(
      (log) => log.outcome === "run_created" && Date.parse(log.at) > windowStartMs,
    ).length;
    if (firesInWindow >= maxPerHour) {
      return await appendLog(
        "suppressed_rate",
        `Rate limit: ${firesInWindow} fires in the last hour (maxPerHour ${maxPerHour}).`,
      );
    }

    // (d) affordability preflight (canStartRun against the gateway ledger).
    const mode: InferenceMode = deps.inferenceMode ?? "managed";
    const verdict = await deps.canStartRun({ userId: trigger.userId, mode });
    if (!verdict.allowed) {
      if (verdict.reason === "ledger_unavailable") {
        if (CAN_START_FAIL_CLOSED_MODES.includes(mode)) {
          // FAIL CLOSED for managed — but an infra outage is not the trigger's
          // fault: no circuit penalty.
          return await appendLog(
            "skipped_funds",
            verdict.detail ?? "Ledger unavailable (managed runs fail closed).",
          );
        }
        // BYO proceeds — the ledger is not billing this run's inference.
      } else {
        // insufficient_funds (or an unspecified denial — treated the same,
        // conservatively): skip + circuit failure.
        const log = await appendLog(
          "skipped_funds",
          verdict.detail ?? "Insufficient funds to start a run.",
        );
        await recordFailureAndMaybePause(deps, trigger.id, at);
        return log;
      }
    }

    // (e) approval gate (exact schedule/webhook-runner semantics).
    const skipReason = await approvalGateSkipReason(trigger, deps.approvals);
    if (skipReason !== null) {
      const log = await appendLog("error", skipReason);
      await recordFailureAndMaybePause(deps, trigger.id, at);
      return log;
    }

    // (e2) Wave 4 pre-run approval hold: a requireApproval trigger that passed
    // every gate is HELD (never dispatched) until an explicit Approve — which
    // re-presents the event with preApproved (S4: the whole chain re-runs; the
    // hold is the only gate skipped). Fails CLOSED when no pending store is
    // wired: an unapproved run must never start.
    if (trigger.requireApproval === true && event.preApproved !== true) {
      if (!deps.pendingApprovals) {
        const log = await appendLog(
          "error",
          "requireApproval is set but pre-run approvals are not available on this instance.",
        );
        await recordFailureAndMaybePause(deps, trigger.id, at);
        return log;
      }
      const token = generateWebhookSecret();
      const pending = await deps.pendingApprovals.createPending({
        triggerId: trigger.id,
        userId: trigger.userId,
        tokenHash: hashWebhookSecret(token),
        event: { name: event.name, payload: event.payload, receivedAt: at },
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + PENDING_APPROVAL_TTL_MINUTES * 60_000).toISOString(),
      });
      let promptDetail = "Held for pre-run approval.";
      if (deps.onApprovalRequested) {
        try {
          await deps.onApprovalRequested(pending, token, trigger, event);
        } catch (err) {
          // Best-effort: an unsendable prompt leaves the hold to expire.
          promptDetail = `Held for pre-run approval (prompt not delivered: ${
            err instanceof Error ? err.message : String(err)
          }).`;
        }
      } else {
        promptDetail = "Held for pre-run approval (no prompt channel configured).";
      }
      return await appendLog("awaiting_approval", promptDetail);
    }

    // (f) fire: build the S1-safe run input and dispatch. A chain fire stamps
    // its depth onto input.event (metadata, not payload) so the created run
    // carries it for the next run_completed hop's loop guard; a message fire
    // stamps its origin so message_reply destinations can post back.
    const input = buildRunInput(trigger.mapping, event.payload, event.name);
    if (event.chainDepth !== undefined || event.origin !== undefined) {
      input.event = {
        name: event.name,
        ...(event.chainDepth !== undefined ? { chainDepth: event.chainDepth } : {}),
        ...(event.origin !== undefined ? { origin: event.origin } : {}),
      };
    }
    const run = await deps.createAndDispatch({ trigger, input, firedAt: at });
    const log = await appendLog("run_created", null, run.id);
    await deps.triggers.resetCircuit(trigger.id);
    await deps.triggers.recordFire(trigger.id, {
      lastFiredAt: at,
      lastRunId: run.id,
      lastError: null,
    });
    return log;
  } catch (err) {
    // NEVER throws out (sweep isolation): any error becomes an "error" fire
    // log + circuit failure, all best-effort.
    const message = err instanceof Error ? err.message : String(err);
    await recordFailureAndMaybePause(deps, trigger.id, at);
    try {
      return await appendLog("error", message);
    } catch {
      // Even the fire log failed — return an unpersisted row so callers still
      // get a truthful outcome.
      return {
        id: "unpersisted",
        triggerId: trigger.id,
        at,
        outcome: "error",
        runId: null,
        detail: message,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// runDueScheduleTriggers (schedule-TYPE sweep — the runDueSchedules analogue)
// ---------------------------------------------------------------------------

/** One isolated per-trigger sweep failure. */
export interface TriggerSweepError {
  triggerId: string;
  error: string;
}

/** Summary of one schedule-trigger sweep. */
export interface TriggerSweepSummary {
  /** Due triggers examined. */
  processed: number;
  /** Triggers that dispatched a run. */
  dispatched: number;
  /** Due triggers suppressed/skipped by a gate (filter/rate/funds/circuit). */
  skipped: number;
  /** Per-trigger failures ("error" outcomes); each is isolated. */
  errors: TriggerSweepError[];
}

/**
 * Process every due schedule-TYPE trigger for this tick — the unified-trigger
 * analogue of runDueSchedules, with the SAME protections:
 *
 *   - DOUBLE-FIRE PREVENTION: the next fire time is computed from `now`
 *     (nextFireAfter) and PERSISTED to the trigger's cursor BEFORE dispatch;
 *     listDue("schedule") selects on cursor <= now, so a re-entrant sweep
 *     cannot select the trigger again. The cursor advances even on skip/error
 *     (no hot-loop); if the cursor cannot be persisted the trigger is NOT
 *     fired this tick (double-fire risk beats a missed fire).
 *   - RESILIENCE: consumeTriggerEvent never throws; each trigger is isolated.
 *
 * Schedule fires route through the SAME gate chain with the degenerate event
 * (no payload): the promptTemplate is used verbatim (no tokens to expand),
 * filters are skipped, and nothing is attached.
 */
export async function runDueScheduleTriggers(
  deps: ConsumeTriggerEventDeps,
  now: string,
): Promise<TriggerSweepSummary> {
  const summary: TriggerSweepSummary = {
    processed: 0,
    dispatched: 0,
    skipped: 0,
    errors: [],
  };

  const due = await deps.triggers.listDue("schedule", now);

  for (const trigger of due) {
    summary.processed += 1;
    if (trigger.type !== "schedule") {
      // listDue("schedule") should only return schedule triggers; a mismatch
      // is a repository bug — isolate it, don't fire.
      summary.errors.push({ triggerId: trigger.id, error: "listDue returned a non-schedule trigger." });
      continue;
    }

    // Compute the next fire up-front so the cursor ALWAYS advances (mirrors
    // runDueSchedules). An unparseable cron (valid at create time) nudges one
    // minute past `now` so the row leaves the due set.
    let nextFire: string;
    try {
      nextFire = nextFireAfter(trigger.config.cron, now, trigger.config.timezone ?? "UTC");
    } catch {
      nextFire = new Date(Date.parse(now) + 60_000).toISOString();
    }

    // PERSIST BEFORE DISPATCH — the double-fire guard.
    try {
      await deps.triggers.updateCursor(trigger.id, nextFire);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push({ triggerId: trigger.id, error: message });
      continue; // cursor not advanced → do NOT fire (double-fire risk).
    }

    const log = await consumeTriggerEvent(
      trigger,
      { name: "schedule", receivedAt: now },
      deps,
    );
    if (log.outcome === "run_created") {
      summary.dispatched += 1;
    } else if (log.outcome === "error") {
      summary.errors.push({ triggerId: trigger.id, error: log.detail ?? "Fire errored." });
    } else {
      summary.skipped += 1;
    }
  }

  return summary;
}
