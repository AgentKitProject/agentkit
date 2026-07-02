// POST   /api/settings/ai-provider  -> add/update a provider (incl. API key)
// DELETE /api/settings/ai-provider   -> remove a provider by id
//
// Secrets: the API key is stored server-side (encrypted at rest when
// AGENTKITFORGE_WEB_SECRET is set) and is NEVER returned to the client.
import { withUser } from "@/lib/api";
import { getUserSettingsStore, type StoredProvider } from "@/server/store/user-settings";

export const dynamic = "force-dynamic";

type SaveBody = {
  id?: string;
  name?: string;
  providerType?: StoredProvider["providerType"];
  baseUrl?: string;
  defaultModel?: string;
  supportsStructuredJson?: boolean;
  apiKey?: string;
};

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as SaveBody;
    if (!body.providerType) throw new Error("providerType is required.");
    const store = await getUserSettingsStore();
    await store.saveProvider(user.id, {
      id: body.id,
      name: body.name ?? body.providerType,
      providerType: body.providerType,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel,
      supportsStructuredJson: body.supportsStructuredJson,
      apiKey: body.apiKey
    });
    return store.getPublic(user.id);
  });
}

export async function DELETE(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json().catch(() => ({}))) as { providerId?: string };
    if (!body.providerId) throw new Error("providerId is required.");
    const store = await getUserSettingsStore();
    await store.removeProvider(user.id, body.providerId);
    return store.getPublic(user.id);
  });
}
