// DELETE /api/gateway/sessions/[id] — end a gateway session (buyer-initiated).
//
// Idempotent: deleting an already-gone or non-owned session returns 204 so the
// client can fire-and-forget cleanup on unmount without leaking whether the id
// existed. Ownership is verified first; a session owned by another user is left
// untouched and reported as 204 (never deleted on their behalf).
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { handleGatewayRequest, loadOwnedSession } from "@/server/core/gateway-sessions";
import { streamGatewayResponse } from "@/server/core/gateway-sse";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  // Not owned / not found → idempotent no-op success.
  if (!owned) return new Response(null, { status: 204 });

  return streamGatewayResponse((createEmitter) =>
    handleGatewayRequest(
      { method: "DELETE", path: `/gateway/sessions/${id}`, userId },
      createEmitter
    )
  );
}
