// POST /api/gateway/sessions/[id]/tool-result — resume a paused turn with the
// client's tool results (SSE).
//
// Body: { results: [{ toolUseId, result?|error? }], model? }. Continues the
// provider loop under the same credit hold and streams events back.
//
// NOTE (conversational-only this pass): the web client does NOT execute tools,
// so it never reaches this route in normal operation. The route is implemented
// for completeness + protocol parity so the seam is ready for desktop local-hands
// (2c) and a future restricted browser tool executor. Session ownership is
// verified up front, same as /turn.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { handleGatewayRequest, loadOwnedSession } from "@/server/core/gateway-sessions";
import { streamGatewayResponse } from "@/server/core/gateway-sse";
import { MANAGED_DEFAULT_MODEL, isManagedModel } from "@/server/core/managed-models";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }

  const { id } = await params;
  const owned = await loadOwnedSession(userId, id);
  if (!owned) {
    return Response.json({ error: "session_not_found", message: "Session not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { results?: unknown; model?: string };
  const model = isManagedModel(body.model) ? body.model! : MANAGED_DEFAULT_MODEL;

  return streamGatewayResponse((createEmitter) =>
    handleGatewayRequest(
      {
        method: "POST",
        path: `/gateway/sessions/${id}/tool-result`,
        body: { results: body.results },
        userId
      },
      createEmitter,
      model
    )
  );
}
