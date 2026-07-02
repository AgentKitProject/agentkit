// Server-side AI provider catalog, sourced from @agentkitforge/core's
// providers/catalog (aiProviderTypes / modelCatalog / capabilities). Exposed to
// the browser as plain JSON so the Settings UI can render provider types and
// known models without importing core into a client bundle.
import { loadCore } from "@/server/core/load-core";

export type ProviderCatalogEntry = {
  providerType: string;
  apiKeyRequired: boolean;
  baseUrlRequired: boolean;
  supportsCustomModels: boolean;
  supportsStructuredJson: boolean;
  defaultModel?: string;
  models: { id: string; label: string; recommendedFor: string[] }[];
};

export async function getProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  const core = await loadCore();
  return core.aiProviderTypes.map((providerType) => {
    const caps = core.getProviderCapabilities(providerType);
    const models = core.getKnownModelsForProvider(providerType);
    return {
      providerType,
      apiKeyRequired: caps.apiKeyRequired,
      baseUrlRequired: caps.baseUrlRequired,
      supportsCustomModels: caps.supportsCustomModels,
      supportsStructuredJson: caps.supportsStructuredJson,
      defaultModel: core.getDefaultModelForProvider(providerType),
      models: models.map((m) => ({ id: m.id, label: m.label, recommendedFor: m.recommendedFor }))
    };
  });
}
