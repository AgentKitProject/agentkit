// POST /api/gateway/sessions/[id]/turn — run one streaming turn (SSE).
//
// Body: { userInput, model? }. Returns a `text/event-stream` of normalized
// gateway StreamEvents (text deltas, usage, done, error). Managed billing
// (hold→settle) happens inside gateway-core; a pre-stream InsufficientCredits
// surfaces as a 402 JSON body (the existing insufficient-credits shape).
//
// Session ownership is verified BEFORE forwarding to the router: the gateway
// router does not re-check that the caller owns the session on /turn, so we gate
// here. A session belonging to another user is reported as 404 (indistinguishable
// from a missing session) so cross-user ids can't be probed.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { handleGatewayRequest, loadOwnedSession } from "@/server/core/gateway-sessions";
import { streamGatewayResponse, refusalSseResponse } from "@/server/core/gateway-sse";
import { isProtectedRef, isPromptExtractionAttempt } from "@/server/core/protected-kits";
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

  const body = (await request.json().catch(() => ({}))) as { userInput?: string; model?: string };
  const model = isManagedModel(body.model) ? body.model! : MANAGED_DEFAULT_MODEL;

  // LEAKAGE GUARD (best-effort): refuse obvious prompt-extraction asks against a
  // protected kit before they reach the model. Inference/paraphrase attacks are
  // not fully preventable — this only blocks the most direct asks.
  if (isProtectedRef(owned.systemPromptRef) && typeof body.userInput === "string" && isPromptExtractionAttempt(body.userInput)) {
    return refusalSseResponse(
      "I can't share or repeat my underlying instructions or system prompt. I'm happy to help you use this kit's capabilities instead."
    );
  }

  return streamGatewayResponse((createEmitter) =>
    handleGatewayRequest(
      {
        method: "POST",
        path: `/gateway/sessions/${id}/turn`,
        body: { userInput: body.userInput },
        userId
      },
      createEmitter,
      model
    )
  );
}
