// POST /api/auto/runs/[id]/cancel — kill-switch (cookie auth).
//
// Auth: AuthKit cookie session. Idempotent; ownership-checked. Requests
// cancellation; the run stops between turns (auto-core's kill-switch). Missing /
// cross-user → 404.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { cancelRun } from "@/server/core/auto";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const ok = await cancelRun(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true, canceling: true }, { status: 202 });
}
