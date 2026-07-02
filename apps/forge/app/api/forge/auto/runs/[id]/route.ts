// GET /api/forge/auto/runs/[id] — run status + result + audit log (BEARER auth).
//
// Auth: WorkOS device-auth bearer (requireForgeUser). Ownership-checked; missing /
// cross-user → 404. The run record carries no injected kit prompt (only kitRef).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { getRun } from "@/server/core/auto";

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
  const run = await getRun(userId, id);
  if (!run) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(run, { status: 200 });
}
