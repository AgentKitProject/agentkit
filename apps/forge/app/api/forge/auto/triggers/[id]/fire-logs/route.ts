// /api/forge/auto/triggers/[id]/fire-logs — recent fire-log rows (BEARER auth).
//
// Response: contracts listTriggerFireLogsResponseSchema ({ fireLogs }).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { listTriggerFireLogs } from "@/server/core/auto-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  const { id } = await params;
  const fireLogs = await listTriggerFireLogs(userId, id);
  if (fireLogs === null) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ fireLogs }, { status: 200 });
}
