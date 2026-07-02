// POST /api/forge/gateway/sessions/[id]/turn — run one streaming turn (SSE) for
// a forge (bearer) session. Gateway Phase 2c-i.
//
// Auth: WorkOS device-auth bearer (requireForgeUser). Body: { userInput, model? }.
// Returns a `text/event-stream` of normalized gateway StreamEvents. If the kit
// declared tools at create, the model may emit `tool_use`; the turn then PAUSES
// (emitting `done` with stopReason "tool_use" + the tool_call) and the client
// resumes via /tool-result. Managed billing (hold→settle) spans the whole turn;
// a pre-stream InsufficientCredits surfaces as a 402 JSON body.
//
// Session ownership is verified BEFORE forwarding to the router (the router does
// not re-check ownership on /turn). A session owned by another user → 404.
import { requireForgeUser, ForgeAuthError, parseBearerToken } from "@/lib/forge-auth";
import {
  handleForgeGatewayRequest,
  loadOwnedForgeSession
} from "@/server/core/forge-gateway-sessions";
import { streamGatewayResponse, refusalSseResponse } from "@/server/core/gateway-sse";
import { isProtectedRef, isPromptExtractionAttempt } from "@/server/core/protected-kits";
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

  const body = (await request.json().catch(() => ({}))) as { userInput?: string; model?: string };
  const model = isManagedModel(body.model) ? body.model! : MANAGED_DEFAULT_MODEL;

  // Forwarded device-auth bearer — needed to fetch a protected kit server-side.
  const bearerToken = parseBearerToken(request.headers.get("authorization")) ?? undefined;

  // LEAKAGE GUARD (best-effort): refuse obvious prompt-extraction asks against a
  // protected kit before they reach the model.
  if (isProtectedRef(owned.systemPromptRef) && typeof body.userInput === "string" && isPromptExtractionAttempt(body.userInput)) {
    return refusalSseResponse(
      "I can't share or repeat my underlying instructions or system prompt. I'm happy to help you use this kit's capabilities instead."
    );
  }

  return streamGatewayResponse((createEmitter) =>
    handleForgeGatewayRequest(
      {
        method: "POST",
        path: `/gateway/sessions/${id}/turn`,
        body: { userInput: body.userInput },
        userId
      },
      createEmitter,
      model,
      bearerToken
    )
  );
}
