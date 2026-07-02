// GET /api/settings/ai-providers -> list configured providers (secrets stripped:
//                                    each carries `hasApiKey`, never the key),
//                                    the default provider id, and the catalog.
// PUT /api/settings/ai-providers -> mutate providers. Body action one of:
//   { action: "save",       provider: {...incl apiKey?} }
//   { action: "remove",     providerId }
//   { action: "setDefault", providerId }
//
// API keys are stored server-side, encrypted at rest when AGENTKITFORGE_WEB_SECRET
// is set (else plaintext + a one-time warning — see user-settings.ts).
import { withUser } from "@/lib/api";
import { getUserSettingsStore, type StoredProvider } from "@/server/store/user-settings";
import { getProviderCatalog } from "@/server/core/provider-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async (user) => {
    const store = await getUserSettingsStore();
    const settings = await store.getPublic(user.id);
    return { providers: settings.providers, defaultProviderId: settings.defaultProviderId, catalog: await getProviderCatalog() };
  });
}

type PutBody =
  | {
      action: "save";
      provider: {
        id?: string;
        name?: string;
        providerType: StoredProvider["providerType"];
        baseUrl?: string;
        defaultModel?: string;
        supportsStructuredJson?: boolean;
        apiKey?: string;
      };
    }
  | { action: "remove"; providerId: string }
  | { action: "setDefault"; providerId: string };

export async function PUT(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as PutBody;
    const store = await getUserSettingsStore();
    if (body.action === "save") {
      if (!body.provider?.providerType) throw new Error("provider.providerType is required.");
      await store.saveProvider(user.id, {
        id: body.provider.id,
        name: body.provider.name ?? body.provider.providerType,
        providerType: body.provider.providerType,
        baseUrl: body.provider.baseUrl,
        defaultModel: body.provider.defaultModel,
        supportsStructuredJson: body.provider.supportsStructuredJson,
        apiKey: body.provider.apiKey
      });
    } else if (body.action === "remove") {
      if (!body.providerId) throw new Error("providerId is required.");
      await store.removeProvider(user.id, body.providerId);
    } else if (body.action === "setDefault") {
      if (!body.providerId) throw new Error("providerId is required.");
      await store.setDefault(user.id, body.providerId);
    } else {
      throw new Error("Unknown action.");
    }
    const settings = await store.getPublic(user.id);
    return { providers: settings.providers, defaultProviderId: settings.defaultProviderId };
  });
}
