// /api/forge/auto/schedules — AgentKitAuto scheduled (cron) runs (BEARER auth).
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser) — NEVER the AuthKit
// cookie (CLAUDE.md hard rule #4). The cookie sibling lives at /api/auto/schedules.
//
//   POST → create a schedule (same body as the cookie sibling).
//   GET  → list the user's schedules.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
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
  budgetCents?: unknown;
  model?: unknown;
  approvalId?: unknown;
  deliveryConfig?: unknown;
};

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
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
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
    const budgetCents =
      typeof body.budgetCents === "number" ? body.budgetCents : await resolveRunBudgetCents(userId);
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

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the caller; an empty list is a valid empty state.
  try {
    const schedules = await listSchedules(userId);
    return Response.json({ schedules }, { status: 200 });
  } catch (error) {
    console.error("[auto] listSchedules failed", error);
    return Response.json({ schedules: [] }, { status: 200 });
  }
}
