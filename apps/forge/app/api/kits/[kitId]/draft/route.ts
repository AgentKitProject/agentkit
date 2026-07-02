// GET /api/kits/:kitId/draft -> loadAgentKitAsDraft
import { withUser } from "@/lib/api";
import { loadKitAsDraft } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const draft = await loadKitAsDraft(user.id, kitId);
    return { draft };
  });
}
