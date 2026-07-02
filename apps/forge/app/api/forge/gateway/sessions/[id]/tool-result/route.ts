// POST /api/forge/gateway/sessions/[id]/tool-result — resume a paused forge turn
// with the client's LOCAL-HANDS tool results (SSE). Gateway Phase 2c-i.
//
// Auth: WorkOS device-auth bearer (requireForgeUser). Body:
//   { results: [{ toolUseId, result? | error? }], model? }.
// After a /turn paused on stop_reason "tool_use", the desktop/CLI executes the
// tool calls locally and POSTs the results here; the provider loop continues
// under the SAME credit hold and streams events back until a natural stop.
//
// Session ownership is verified up front, same as /turn.
import { requireForgeUser, ForgeAuthError, parseBearerToken } from "@/lib/forge-auth";
import {
  handleForgeGatewayRequest,
  loadOwnedForgeSession
} from "@/server/core/forge-gateway-sessions";
import { streamGatewayResponse } from "@/server/core/gateway-sse";
import { MANAGED_DEFAULT_MODEL, isManagedModel } from "@/server/core/managed-models";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const owned = await loadOwnedForgeSession(userId, id);
  if (!owned) {
    return Response.json({ error: "session_not_found", message: "Session not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { results?: unknown; model?: string };
  const model = isManagedModel(body.model) ? body.model! : MANAGED_DEFAULT_MODEL;

  // Forwarded device-auth bearer — needed to re-fetch a protected kit prompt
  // server-side on resume (and to drive the leakage-redaction emitter).
  const bearerToken = parseBearerToken(request.headers.get("authorization")) ?? undefined;

  return streamGatewayResponse((createEmitter) =>
    handleForgeGatewayRequest(
      {
        method: "POST",
        path: `/gateway/sessions/${id}/tool-result`,
        body: { results: body.results },
        userId
      },
      createEmitter,
      model,
      bearerToken
    )
  );
}
