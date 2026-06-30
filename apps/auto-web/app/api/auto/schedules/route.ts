// /api/auto/schedules — AgentKitAuto scheduled (cron) runs (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi). The bearer sibling lives at
// /api/forge/auto/schedules (CLAUDE.md hard rule #4 — never mix the two paths).
//
//   POST → create a schedule { kitRef, cron, timezone?, input/prompt, budgetCents
//          (REQUIRED), model?, approvalId (REQUIRED) }. Validates cron + the
//          standing approval (must belong to the user + match kitRef + cover the
//          budget); computes the initial nextRunAt server-side.
//   GET  → list the user's schedules.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  ApprovalDeniedError,
  AutoValidationError,
  createSchedule,
  listSchedules,
  parseDeliveryConfig,
  parseKitRef
} from "@/server/core/auto";
import { resolveRunBudgetCents } from "@/server/core/run-budget";

export const dynamic = "force-dynamic";

type ScheduleBody = {
  kitRef?: unknown;
  cron?: unknown;
  timezone?: unknown;
  input?: { prompt?: unknown; files?: unknown };
  prompt?: unknown;
  model?: unknown;
  approvalId?: unknown;
  deliveryConfig?: unknown;
};

/** Shared body → createSchedule args parsing (used by both auth siblings via copy;
 *  kept tiny + local to each route to avoid an extra shared module). */
function parseFiles(input?: { files?: unknown }): { path: string; content: string }[] | undefined {
  return Array.isArray(input?.files)
    ? (input.files as unknown[]).flatMap((f) =>
        f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string"
          ? [{ path: String((f as Record<string, unknown>).path), content: String((f as Record<string, unknown>).content ?? "") }]
          : []
      )
    : undefined;
}

export async function POST(request: Request) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as ScheduleBody;
  try {
    const kitRef = parseKitRef(body.kitRef);
    const cron = typeof body.cron === "string" ? body.cron : "";
    const timezone = typeof body.timezone === "string" ? body.timezone : undefined;
    const prompt =
      typeof body.input?.prompt === "string"
        ? body.input.prompt
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    const files = parseFiles(body.input);
    // Per-run budget is resolved server-side (org override → user default → 50¢).
    const budgetCents = await resolveRunBudgetCents(userId);
    const model = typeof body.model === "string" ? body.model : undefined;
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
    // Phase D: opt-in result delivery copied onto every run this schedule fires.
    const deliveryConfig = parseDeliveryConfig(body.deliveryConfig);

    const schedule = await createSchedule({
      userId,
      kitRef,
      cron,
      ...(timezone ? { timezone } : {}),
      prompt,
      budgetCents,
      approvalId,
      ...(model ? { model } : {}),
      ...(files ? { files } : {}),
      ...(deliveryConfig ? { deliveryConfig } : {})
    });
    return Response.json(schedule, { status: 201 });
  } catch (error) {
    if (error instanceof ApprovalDeniedError) {
      return Response.json({ error: autoErrorCodeSchema.enum.approval_denied, message: error.message }, { status: 403 });
    }
    if (error instanceof AutoValidationError) {
      return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function GET() {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the Auto page load; the UI renders an empty state.
  try {
    const schedules = await listSchedules(userId);
    return Response.json({ schedules }, { status: 200 });
  } catch (error) {
    console.error("[auto] listSchedules failed", error);
    return Response.json({ schedules: [] }, { status: 200 });
  }
}
