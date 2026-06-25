// GET  /api/kits        -> listUserKits          (ForgeClient.listMyKits)
import { withUser } from "@/lib/api";
import { getKitStore } from "@/server/store/local-disk";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async (user) => {
    const kits = await (await getKitStore()).listUserKits(user.id);
    return { kits };
  });
}
