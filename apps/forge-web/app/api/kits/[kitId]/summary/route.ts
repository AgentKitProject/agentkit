// GET /api/kits/:kitId/summary -> getAgentKitSummary
import { withUser } from "@/lib/api";
import { getKitSummary } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const summary = await getKitSummary(user.id, kitId);
    return { summary };
  });
}
