// POST /api/forge/auto/runs/[id]/cancel — kill-switch (BEARER auth).
//
// Auth: WorkOS device-auth bearer (requireForgeUser). Idempotent; ownership-checked.
// Missing / cross-user → 404.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { cancelRun } from "@/server/core/auto";

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
  const ok = await cancelRun(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true, canceling: true }, { status: 202 });
}
