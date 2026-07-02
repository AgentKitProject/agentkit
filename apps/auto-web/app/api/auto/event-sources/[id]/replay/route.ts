// /api/auto/event-sources/[id]/replay — re-consume a STORED event through the
// source's subscribed triggers (BROWSER / cookie; owner-only). Body:
// contracts replayEventRequestSchema ({ eventId }). The fire clock is NOW, so
// rate limits / circuit breakers apply afresh.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { autoEventErrorResponse, replayEvent } from "@/server/core/auto-events";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await replayEvent(userId, id, body);
    if (!result) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
    return Response.json(result, { status: 200 });
  } catch (error) {
    const mapped = autoEventErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
}
