// /api/forge/auto/event-sources/[id]/rotate-token — rotate the ingest bearer token
// (BEARER auth). The old token stops authenticating immediately; the NEW
// plaintext token is returned ONCE (only its hash is stored — S2).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { rotateEventSourceToken } from "@/server/core/auto-events";

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
  const rotated = await rotateEventSourceToken(userId, id);
  if (!rotated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(rotated, { status: 200 });
}
