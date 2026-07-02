// POST /api/forge/auto/approvals/[id]/revoke — revoke an approval (BEARER auth).
//
// Auth: WorkOS device-auth bearer (requireForgeUser). Ownership-checked; missing /
// cross-user → 404.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { revokeApproval } from "@/server/core/auto";

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
  const updated = await revokeApproval(userId, id);
  if (!updated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(updated, { status: 200 });
}
