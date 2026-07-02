// /api/forge/auto/event-sources/[id]/events — inspector list (BEARER auth).
//
// Newest-first ring-buffer contents (contracts listReceivedEventsResponseSchema).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { listSourceEvents } from "@/server/core/auto-events";

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
  const events = await listSourceEvents(userId, id);
  if (events === null) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ events }, { status: 200 });
}
