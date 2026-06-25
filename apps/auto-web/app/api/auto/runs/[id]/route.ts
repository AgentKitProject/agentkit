// GET /api/auto/runs/[id] — run status + result + audit log (cookie auth).
//
// Auth: AuthKit cookie session. Ownership-checked; missing / cross-user → 404.
// The run record carries NO injected kit prompt (only the kitRef), so returning
// it never leaks protected-kit content.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { getRun } from "@/server/core/auto";

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
  const run = await getRun(userId, id);
  if (!run) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(run, { status: 200 });
}
