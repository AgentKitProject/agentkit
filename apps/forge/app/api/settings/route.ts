// GET  /api/settings -> per-user public settings (providers minus secrets,
//                        default provider, preferences, AI provider catalog).
// POST /api/settings -> save app preferences (free-form bag).
import { withUser } from "@/lib/api";
import { getUserSettingsStore } from "@/server/store/user-settings";
import { getProviderCatalog } from "@/server/core/provider-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async (user) => {
    const store = await getUserSettingsStore();
    const settings = await store.getPublic(user.id);
    const catalog = await getProviderCatalog();
    return { ...settings, catalog };
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as Record<string, unknown>;
    // Preferences are stored opaquely; AI providers have dedicated routes.
    const store = await getUserSettingsStore();
    await store.setPreferences(user.id, body);
    return store.getPublic(user.id);
  });
}
