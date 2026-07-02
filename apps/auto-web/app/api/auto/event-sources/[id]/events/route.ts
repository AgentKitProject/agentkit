// /api/auto/event-sources/[id]/events — inspector list (BROWSER / cookie).
//
// Newest-first ring-buffer contents (contracts listReceivedEventsResponseSchema).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { listSourceEvents } from "@/server/core/auto-events";

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
  const events = await listSourceEvents(userId, id);
  if (events === null) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ events }, { status: 200 });
}
