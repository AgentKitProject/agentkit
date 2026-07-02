// POST   /api/settings/openai-key -> set the API key on the user's OpenAI
//                                     provider (creating it if absent).
// DELETE /api/settings/openai-key -> remove the OpenAI provider.
//
// Convenience shim that mirrors the desktop saveOpenAiApiKey/clearOpenAiApiKey
// over the general per-user provider store. The key is stored server-side
// (encrypted at rest when AGENTKITFORGE_WEB_SECRET is set) and never returned.
import { withUser } from "@/lib/api";
import { getUserSettingsStore } from "@/server/store/user-settings";

export const dynamic = "force-dynamic";

const OPENAI_ID = "openai-default";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as { apiKey?: string };
    if (!body.apiKey?.trim()) throw new Error("apiKey is required.");
    const store = await getUserSettingsStore();
    await store.saveProvider(user.id, {
      id: OPENAI_ID,
      name: "OpenAI",
      providerType: "openai",
      apiKey: body.apiKey
    });
    return store.getPublic(user.id);
  });
}

export async function DELETE() {
  return withUser(async (user) => {
    const store = await getUserSettingsStore();
    await store.removeProvider(user.id, OPENAI_ID);
    return store.getPublic(user.id);
  });
}
