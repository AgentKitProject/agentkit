// POST /api/kits/:kitId/export/onefile -> exportAgentKitOneFile (returns text)
import { withUser } from "@/lib/api";
import { exportOneFile } from "@/server/core/operations";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => exportOneFile(user.id, kitId));
}
