// POST /api/auto/approvals/[id]/revoke — revoke a standing approval (cookie auth).
//
// Auth: AuthKit cookie session. Ownership-checked; a missing / cross-user approval
// returns 404 (so cross-user probing can't distinguish the two).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { revokeApproval } from "@/server/core/auto";

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
  const updated = await revokeApproval(userId, id);
  if (!updated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(updated, { status: 200 });
}
