// /api/auto/triggers/[id]/fire-logs — recent fire-log rows (BROWSER / cookie).
//
// Response: contracts listTriggerFireLogsResponseSchema ({ fireLogs }).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { listTriggerFireLogs } from "@/server/core/auto-events";

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
  const fireLogs = await listTriggerFireLogs(userId, id);
  if (fireLogs === null) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ fireLogs }, { status: 200 });
}
