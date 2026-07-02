// POST /api/settings/ai-provider/default -> set the user's default provider.
import { withUser } from "@/lib/api";
import { getUserSettingsStore } from "@/server/store/user-settings";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as { providerId?: string };
    if (!body.providerId) throw new Error("providerId is required.");
    const store = await getUserSettingsStore();
    await store.setDefault(user.id, body.providerId);
    return store.getPublic(user.id);
  });
}
