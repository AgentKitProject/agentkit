// Pure helpers for addressing a run/approval kit by an opaque selector value and
// for parsing the Market "run on Auto" deep link. Extracted from AutoSection so
// the selection/deep-link logic is unit-testable without a DOM/React.
//
// A kit selector value is one of:
//   • a raw local kit id (KitStore)             → { source: "local", localKitId }
//   • `market:<slug>` for a purchased protected → { source: "market", marketKitId, slug }
//
// `market:<slug>` is the shape the Market commercial UI deep-links to:
//   ${AUTO_URL}/?kit=market:<slug>   (slug = the Market service lookup key).

/** A run/approval kit reference (market-aware). */
export type KitRef =
  | { source: "local"; localKitId: string }
  | { source: "market"; marketKitId: string; slug: string };

/** A browser-safe protected entitled kit (from GET /api/auto/entitled-kits). */
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
 * Resolve a selector value to a KitRef, or null if a `market:` value doesn't
 * resolve to one of the user's entitled kits (so a stale deep-link can't fake an
 * entitlement — the run is still independently entitlement-gated server-side, but
 * the UI also refuses to build a kitRef for an un-owned slug).
 */
export function parseKitSelection(value: string, entitled: EntitledKit[]): KitRef | null {
  if (!value) return null;
  if (value.startsWith(MARKET_PREFIX)) {
    const slug = value.slice(MARKET_PREFIX.length);
    const kit = entitled.find((k) => k.slug === slug);
    return kit ? { source: "market", marketKitId: kit.marketKitId, slug: kit.slug } : null;
  }
  return { source: "local", localKitId: value };
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

/**
 * Which "costs Auto credits" disclosure to show before starting a run, given the
 * selected kit and whether THIS deployment meters runs:
 *   • "full"  — a protected Market kit on a METERED deployment: show the full
 *               disclosure (live rates + balance + buy-credits + residual-risk).
 *   • "brief" — a protected Market kit on an UNMETERED deployment (free
 *               self-host with a Market): no credits cost, but still note the
 *               server-side / output-only nature.
 *   • "none"  — a local/free kit: no protected-kit disclosure.
 * Mirrors the JSX gating in AutoSection so the gating is unit-testable.
 */
export function creditsDisclosureKind(selectionValue: string, metered: boolean): "full" | "brief" | "none" {
  if (!isMarketSelection(selectionValue)) return "none";
  return metered ? "full" : "brief";
}
