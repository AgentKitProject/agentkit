// DELETE /api/forge/gateway/sessions/[id] — end a forge (bearer) gateway session.
//
// Auth: WorkOS device-auth bearer (requireForgeUser). Idempotent: deleting an
// already-gone or non-owned session returns 204 (cross-user ids can't be probed).
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import {
  handleForgeGatewayRequest,
  loadOwnedForgeSession
} from "@/server/core/forge-gateway-sessions";
import { streamGatewayResponse } from "@/server/core/gateway-sse";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  // Not owned / not found → idempotent no-op success.
  if (!owned) return new Response(null, { status: 204 });

  return streamGatewayResponse((createEmitter) =>
    handleForgeGatewayRequest(
      { method: "DELETE", path: `/gateway/sessions/${id}`, userId },
      createEmitter
    )
  );
}
