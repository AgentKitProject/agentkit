/**
 * Forge ↔ Market (Seam A) route builders.
 *
 * Single source of truth: re-exported from the public
 * `@agentkitforge/contracts` package (a real runtime dependency now that both
 * core and contracts are published). The previous hand-mirrored copy is gone —
 * `forgeMarketRoutes` here is the contracts definition verbatim, so submit /
 * download / update consumers all share one canonical Seam-A shape.
 */

export { forgeMarketRoutes, forgePricingRoutes } from "@agentkitforge/contracts";

/**
 * Forge cloud-favorites routes (Seam A). LIVE in Market prod but not yet in
 * `@agentkitforge/contracts`; declared locally until promoted into contracts.
 */
export const forgeFavoriteRoutes = {
  /** GET (list) / POST (add) the signed-in user's favorites. */
  list: (): string => "/api/forge/favorites",
  /** DELETE a single favorite by kit id. */
  remove: (kitId: string): string =>
    `/api/forge/favorites/${encodeURIComponent(kitId)}`
} as const;
