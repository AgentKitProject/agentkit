// /api/auto/schedules/[id] — get / patch (enable·disable·edit) / delete a schedule
// (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session. Ownership-checked; missing / cross-user → 404.
// The bearer sibling lives at /api/forge/auto/schedules/[id].
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  ApprovalDeniedError,
  AutoValidationError,
  deleteSchedule,
  getSchedule,
  updateSchedule
} from "@/server/core/auto";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const schedule = await getSchedule(userId, id);
  if (!schedule) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(schedule, { status: 200 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    cron?: unknown;
    timezone?: unknown;
    prompt?: unknown;
    budgetCents?: unknown;
    model?: unknown;
    approvalId?: unknown;
    enabled?: unknown;
  };
  try {
    const patch: Parameters<typeof updateSchedule>[2] = {};
    if (typeof body.cron === "string") patch.cron = body.cron;
    if (typeof body.timezone === "string") patch.timezone = body.timezone;
    if (typeof body.prompt === "string") patch.prompt = body.prompt;
    if (typeof body.budgetCents === "number") patch.budgetCents = body.budgetCents;
    if (typeof body.model === "string") patch.model = body.model;
    if (typeof body.approvalId === "string") patch.approvalId = body.approvalId;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

    const updated = await updateSchedule(userId, id, patch);
    if (!updated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
    return Response.json(updated, { status: 200 });
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

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const ok = await deleteSchedule(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}
