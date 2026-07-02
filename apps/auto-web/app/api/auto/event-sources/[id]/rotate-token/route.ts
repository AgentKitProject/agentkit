// /api/auto/event-sources/[id]/rotate-token — rotate the ingest bearer token
// (BROWSER / cookie). The old token stops authenticating immediately; the NEW
// plaintext token is returned ONCE (only its hash is stored — S2).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { rotateEventSourceToken } from "@/server/core/auto-events";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const rotated = await rotateEventSourceToken(userId, id);
  if (!rotated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(rotated, { status: 200 });
}
