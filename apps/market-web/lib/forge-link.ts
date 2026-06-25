const DEFAULT_MARKET_BASE_URL = "https://market.agentkitproject.com";
const FORGE_BASE_URL = "https://forge.agentkitproject.com";
const FORGE_PROTOCOL_BASE = "agentkitforge://market/import";

export type ForgeImportLinkInput = {
  slug: string;
  kitId?: string;
  marketBaseUrl?: string;
};

export function buildForgeImportDeepLink({ slug, kitId, marketBaseUrl = getMarketBaseUrl() }: ForgeImportLinkInput) {
  const url = new URL(FORGE_PROTOCOL_BASE);

  url.searchParams.set("market", normalizedMarketBaseUrl(marketBaseUrl));
  url.searchParams.set("kit", slug);

  if (kitId) {
    url.searchParams.set("kitId", kitId);
  }

  return url.toString();
}

export function getForgeWebUrl(): string | undefined {
  // Operator override (any deployment) takes precedence.
  const override = process.env.NEXT_PUBLIC_FORGE_URL?.replace(/\/+$/, "");
  if (override) {
    return override;
  }

  // Self-host: no vendor link to the public hosted Forge.
  if (process.env.SELF_HOST === "true") {
    return undefined;
  }

  // Hosted default.
  return FORGE_BASE_URL;
}

export function getMarketBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || DEFAULT_MARKET_BASE_URL).replace(/\/+$/, "");
}

function normalizedMarketBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}
