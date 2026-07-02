// Pure helpers for addressing a protected Market kit by an opaque selector value
// and for parsing the Market "run / use in Forge (web)" deep link. Extracted so
// the selection / deep-link logic is unit-testable without a DOM/React. Mirrors
// auto-web/app/sections/market-kit-ref.ts (same wire shapes).
//
// A protected-kit selector value is `market:<slug>` (the Market service lookup
// key); the canonical deep link is:
//   ${FORGE_WEB_URL}/forge?kit=market:<slug>&kitId=<id>

/** A protected Market kit reference (browser-safe; resolved from the user's
 *  entitled list so a stale deep-link can't fake an entitlement). */
export type MarketKitRef = { marketKitId: string; slug: string };

/** A browser-safe protected entitled kit (from GET /api/forge/entitled-kits). */
export type EntitledKit = { marketKitId: string; slug: string; name: string };

/** The selector-value prefix that marks a protected Market kit. */
export const MARKET_PREFIX = "market:";

/** The selector value for a Market kit (keyed by its slug). */
export function marketSelectionValue(slug: string): string {
  return `${MARKET_PREFIX}${slug}`;
}

/** True when a selector value addresses a protected Market kit. */
export function isMarketSelection(value: string): boolean {
  return value.startsWith(MARKET_PREFIX);
}

/**
 * Resolve a `market:<slug>` selector value to a MarketKitRef, or null when the
 * slug isn't one of the user's entitled kits (so a stale deep-link can't fake an
 * entitlement — the run is still independently entitlement-gated server-side,
 * but the UI also refuses to build a ref for an un-owned slug).
 */
export function resolveMarketSelection(value: string, entitled: EntitledKit[]): MarketKitRef | null {
  if (!value.startsWith(MARKET_PREFIX)) return null;
  const slug = value.slice(MARKET_PREFIX.length);
  const kit = entitled.find((k) => k.slug === slug);
  return kit ? { marketKitId: kit.marketKitId, slug: kit.slug } : null;
}

/**
 * Parse the `?kit=` deep-link param into a Market slug, or null when it isn't a
 * `market:<slug>` link. Trims whitespace; an empty slug yields null.
 */
export function parseMarketDeepLink(kitParam: string | null | undefined): string | null {
  if (!kitParam || !kitParam.startsWith(MARKET_PREFIX)) return null;
  const slug = kitParam.slice(MARKET_PREFIX.length).trim();
  return slug.length > 0 ? slug : null;
}
