// /api/internal/auto/sweep — INTERNAL scheduled-run sweep (Phase B).
//
// THIRD auth path: SERVICE KEY ONLY. This endpoint is invoked once per minute by
// the EventBridge → Lambda cron tick (NOT a browser, NOT Forge). It must NEVER use
// the AuthKit cookie helpers or the Forge bearer helper (requireForgeUser) — those
// are the other two, separate auth paths (CLAUDE.md hard rule #4). The service key
// is the sole authorization.
//
// REUSED TRUST BOUNDARY: this is the SAME "our-infra → web-forge internal" trust
// boundary as /api/internal/auto/resolve-context, so it reuses the identical
// AUTO_WORKER_SERVICE_KEY constant-time check pattern. The per-minute Lambda
// presents the key it was provisioned with (x-service-key or Authorization:
// Bearer). When the key is unset the endpoint is DISABLED (503) — it never falls
// back to unauthenticated access.
//
// On call it runs ONE scheduling sweep (runScheduleSweep): auto-core's
// runDueSchedules selects due schedules, re-checks each against its standing
// approval, dispatches a run via the SAME path startRun uses (Fargate on hosted)
// with trigger "schedule" + scheduleId, advances nextRunAt to prevent double-fire,
// and returns a summary. The sweep itself is quick (it only creates + dispatches);
// the runs execute on Fargate.
//
// SECURITY: never logs the service key. Logs only the non-sensitive sweep summary
// counts (processed/dispatched/skipped/errors).
import { autoErrorCodeSchema, autoInternalServiceKeyHeader } from "@agentkitforge/contracts";
import { timingSafeEqual } from "node:crypto";
import { runScheduleSweep } from "@/server/core/auto";
import { runTriggerPollSweep, runTriggerScheduleSweep } from "@/server/core/auto-events";

export const dynamic = "force-dynamic";

/** Constant-time compare. timingSafeEqual throws on differing lengths, so we
 *  reject a length mismatch first (the length itself is not the secret). Mirrors
 *  the resolve-context route exactly. */
function serviceKeyMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the presented service key from x-service-key OR Authorization: Bearer. */
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

export async function POST(request: Request) {
  // ---- Service-key gate (THIRD auth path; service key only) ----------------
  const expected = process.env.AUTO_WORKER_SERVICE_KEY;
  if (!expected || expected.length === 0) {
    // Disabled until a key is configured — never allow unauthenticated access.
    return Response.json({ error: autoErrorCodeSchema.enum.internal_auth_unconfigured }, { status: 503 });
  }
  const presented = presentedKey(request);
  if (!presented || !serviceKeyMatches(expected, presented)) {
    return Response.json({ error: autoErrorCodeSchema.enum.unauthorized }, { status: 401 });
  }

  // ---- Run one sweep -------------------------------------------------------
  const summary = await runScheduleSweep();

  // Log ONLY non-sensitive counts (never the service key).
  // eslint-disable-next-line no-console
  console.info(
    `[auto] schedule sweep processed=${summary.processed} dispatched=${summary.dispatched} skipped=${summary.skipped} errors=${summary.errors.length}`
  );

  // ---- ADDITIVE: schedule-TYPE unified triggers (event-driven expansion) ---
  // Runs AFTER the legacy schedule sweep with the SAME isolation discipline: a
  // trigger-sweep failure never fails the legacy sweep (or the endpoint).
  let triggerSummary: Awaited<ReturnType<typeof runTriggerScheduleSweep>> | { error: string };
  try {
    triggerSummary = await runTriggerScheduleSweep();
    // eslint-disable-next-line no-console
    console.info(
      `[auto] trigger sweep processed=${triggerSummary.processed} dispatched=${triggerSummary.dispatched} skipped=${triggerSummary.skipped} errors=${triggerSummary.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[auto] trigger sweep failed: ${message}`);
    triggerSummary = { error: message };
  }

  // ---- ADDITIVE: Wave-3b pollers (watch / rss / run_completed) -------------
  // Same isolation discipline: a poll-sweep failure never fails the legacy or
  // trigger sweeps (or the endpoint). runTriggerPollSweep additionally isolates
  // each poller AND each trigger internally.
  let pollSummary: Awaited<ReturnType<typeof runTriggerPollSweep>> | { error: string };
  try {
    pollSummary = await runTriggerPollSweep();
    for (const [kind, s] of Object.entries(pollSummary)) {
      // eslint-disable-next-line no-console
      console.info(
        `[auto] ${kind} poll sweep processed=${s.processed} dispatched=${s.dispatched} skipped=${s.skipped} errors=${s.errors.length}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[auto] poll sweep failed: ${message}`);
    pollSummary = { error: message };
  }

  return Response.json(
    { ...summary, triggerSweep: triggerSummary, pollSweep: pollSummary },
    { status: 200 }
  );
}
