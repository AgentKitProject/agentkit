// GET /api/kits/:kitId/tree -> getKitTree (full file tree for the editor)
import { withUser } from "@/lib/api";
import { getKitStore } from "@/server/store/local-disk";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const tree = await (await getKitStore()).getKitTree(user.id, kitId);
    return { tree };
  });
}
