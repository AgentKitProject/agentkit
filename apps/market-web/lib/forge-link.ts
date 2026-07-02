const DEFAULT_MARKET_BASE_URL = "https://market.agentkitproject.com";
// Web Forge (the desktop app is retired). The short apex forge.agentkitproject.com
// 301-redirects here but drops query params, so link straight to the app.
const FORGE_BASE_URL = "https://forge.agentkitproject.com";
const AUTO_BASE_URL = "https://auto.agentkitproject.com";

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

/**
 * The PUBLIC AgentKitAuto app URL — where a buyer is sent to run a purchased
 * PROTECTED kit ("Run on Auto"). Operator override via NEXT_PUBLIC_AUTO_URL.
 * Self-host returns undefined unless the operator configures it (so a self-host
 * with no Auto deployment simply hides the action). Hosted falls back to the
 * public auto.agentkitproject.com. Never an internal/service URL — this is a
 * browser navigation target.
 */
export function getAutoWebUrl(): string | undefined {
  const override = process.env.NEXT_PUBLIC_AUTO_URL?.replace(/\/+$/, "");
  if (override) return override;
  if (process.env.SELF_HOST === "true") return undefined;
  return AUTO_BASE_URL;
}

/**
 * The "Run on Auto" deep link for a PROTECTED kit: `${autoUrl}/?kit=market:<slug>`
 * (plus `&kitId=<marketKitId>` when known). Mirrors the param shape AutoSection
 * parses. URL-safe (slug/kitId encoded). Returns undefined when no Auto URL is
 * configured (self-host with no Auto) so the caller hides the action.
 */
export function buildRunOnAutoLink({ slug, kitId }: { slug: string; kitId?: string }): string | undefined {
  const base = getAutoWebUrl();
  if (!base) return undefined;
  const url = new URL(`${base}/`);
  url.searchParams.set("kit", `market:${slug}`);
  if (kitId) url.searchParams.set("kitId", kitId);
  return url.toString();
}

/**
 * The "Use in Forge (web)" deep link for a PROTECTED kit:
 * `${forgeWebUrl}/forge?kit=market:<slug>` (plus `&kitId=<marketKitId>` when
 * known). Web Forge runs the kit INTERACTIVELY (a gateway protected session);
 * Auto runs it AUTONOMOUSLY. Mirrors the param shape the forge page parses.
 * URL-safe (slug/kitId encoded). Returns undefined when no web-Forge URL is
 * configured (self-host with no Forge) so the caller hides the action.
 */
export function buildRunInForgeWebLink({ slug, kitId }: { slug: string; kitId?: string }): string | undefined {
  const base = getForgeWebUrl();
  if (!base) return undefined;
  const url = new URL(`${base}/forge`);
  url.searchParams.set("kit", `market:${slug}`);
  if (kitId) url.searchParams.set("kitId", kitId);
  return url.toString();
}
