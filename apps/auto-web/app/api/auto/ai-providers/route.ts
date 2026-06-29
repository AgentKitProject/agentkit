// /api/auto/ai-providers — generalized per-user AI provider manager
// (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi) — NEVER the forge bearer
// (CLAUDE.md hard rule #4). This is the multi-provider analogue of the legacy
// single-key /api/auto/byo-key route: a user can configure a provider of ANY of
// the 5 supported types (anthropic / openai / gemini / ollama /
// openai-compatible) with an apiKey + optional baseUrl + model, list them, set a
// default, and remove them. The run-resolution path already reads the user's
// selected/default provider from the SAME UserSettingsStore
// (resolveProvider(userId) → defaultProviderId), so a non-Anthropic default just
// works — this route only widens the write surface.
//
//   GET → { providers, defaultProviderId, catalog } — providers carry `hasApiKey`
//         only (secrets stripped), the catalog drives the add/update form.
//   PUT → mutate. Body action one of:
//           { action: "save",       provider: {...incl apiKey?} }
//           { action: "remove",     providerId }
//           { action: "setDefault", providerId }
//
// SECURITY: API keys are SECRETS. They are encrypted at rest by the
// UserSettingsStore (AES-256-GCM via AGENTKITFORGE_WEB_SECRET), NEVER returned by
// any response, and NEVER logged. The provider-lock (ALLOWED_PROVIDERS) is
// enforced SERVER-SIDE in the store's saveProvider (assertProviderAllowed) — a
// forged request cannot save a disallowed provider type even though the UI also
// hides disallowed options.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { getUserSettingsStore } from "@/server/store/user-settings";
import type { StoredProvider } from "@/server/store/settings-types";
import { getProviderCatalog } from "@/server/core/provider-catalog";

export const dynamic = "force-dynamic";

async function userIdOr401(): Promise<{ userId: string } | { response: Response }> {
  try {
    return { userId: (await requireUserForApi()).id };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { response: Response.json({ error: error.message }, { status: 401 }) };
    }
    throw error;
  }
}

function badRequest(message: string): Response {
  return Response.json(
    { error: autoErrorCodeSchema.enum.invalid_request, message },
    { status: 400 }
  );
}

export async function GET() {
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;
  const store = await getUserSettingsStore();
  const settings = await store.getPublic(auth.userId);
  return Response.json(
    {
      providers: settings.providers,
      defaultProviderId: settings.defaultProviderId,
      catalog: await getProviderCatalog()
    },
    { status: 200 }
  );
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
  const auth = await userIdOr401();
  if ("response" in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as Partial<PutBody>;
  const store = await getUserSettingsStore();

  try {
    if (body.action === "save") {
      const provider = body.provider;
      if (!provider?.providerType) return badRequest("provider.providerType is required.");
      // saveProvider enforces the ALLOWED_PROVIDERS lock (assertProviderAllowed)
      // and encrypts apiKey at rest. It seeds defaultProviderId on the first save.
      await store.saveProvider(auth.userId, {
        id: provider.id,
        name: provider.name ?? provider.providerType,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
        supportsStructuredJson: provider.supportsStructuredJson,
        apiKey: provider.apiKey
      });
    } else if (body.action === "remove") {
      if (!body.providerId) return badRequest("providerId is required.");
      await store.removeProvider(auth.userId, body.providerId);
    } else if (body.action === "setDefault") {
      if (!body.providerId) return badRequest("providerId is required.");
      await store.setDefault(auth.userId, body.providerId);
    } else {
      return badRequest("Unknown action.");
    }
  } catch (error) {
    // The provider-lock rejection (and unknown-provider-id on setDefault) surface
    // as plain Errors — return them as a 400 with the (key-free) message. The
    // store NEVER includes a secret in these messages.
    return badRequest(error instanceof Error ? error.message : "Failed to update provider.");
  }

  const settings = await store.getPublic(auth.userId);
  return Response.json(
    { providers: settings.providers, defaultProviderId: settings.defaultProviderId },
    { status: 200 }
  );
}
