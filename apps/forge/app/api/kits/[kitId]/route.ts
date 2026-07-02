// GET    /api/kits/:kitId  -> getAgentKitMetadata
// DELETE /api/kits/:kitId  -> deleteKit (removeKitFromLibrary)
import { withUser } from "@/lib/api";
import { getKitStore } from "@/server/store/local-disk";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    const meta = await (await getKitStore()).getKitMetadata(user.id, kitId);
    if (!meta) throw new Error("Kit not found.");
    return { kit: meta };
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ kitId: string }> }) {
  const { kitId } = await params;
  return withUser(async (user) => {
    await (await getKitStore()).deleteKit(user.id, kitId);
    return { ok: true };
  });
}
