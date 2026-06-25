// GET /api/kits/:kitId/next-version -> nextAgentKitVersion
import { withUser } from "@/lib/api";
import { nextKitVersion } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => nextKitVersion(user.id, kitId));
}
