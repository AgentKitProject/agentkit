/**
 * Hosted-AgentKitMarket CLOUD FAVORITES (opt-in sync).
 *
 * A signed-in user's favorited Market kits sync to the same server-side store
 * the Market web app uses. Forge device-auth bearer routes:
 *   - GET    /api/forge/favorites        → list ({ items: [...] })
 *   - POST   /api/forge/favorites        → add (body { slug } or { kitId })
 *   - DELETE /api/forge/favorites/{kitId} → remove
 *
 * Opt-in / additive only: these are token-gated; nothing here runs unless the
 * caller already has a hosted-Market session. The pure spec engine never
 * imports this module.
 *
 * Mirrors the existing client ops (downloadKit/checkKitUpdate): the bearer is
 * attached via {@link authedRequest} + {@link TokenStore}, with the once-on-401
 * refresh-and-retry behaviour. Never log token values.
 *
 * NOTE (contracts-first): the favorites routes are LIVE in Market prod but are
 * not yet defined in `@agentkitforge/contracts`. They are declared locally in
 * `./routes.ts` (forgeFavoriteRoutes) until promoted into the contracts package.
 */

import { forgeFavoriteRoutes } from "./routes.js";
import {
  authedRequest,
  normalizeMarketBaseUrl,
  type FetchLike,
  type MarketRequestOptions
} from "./http.js";
import type { TokenStore } from "./types.js";
import { normalizeMarketIdentifier } from "./download.js";

/** A synced cloud favorite as returned by the hosted Market. */
export interface Favorite {
  kitId: string;
  slug: string;
  /** ISO-8601 timestamp of when the favorite was added. */
  addedAt: string;
  displayName?: string;
  summary?: string;
  publisherName?: string;
}

export interface ListFavoritesOptions extends MarketRequestOptions {}

export interface AddFavoriteOptions extends MarketRequestOptions {}

export interface RemoveFavoriteOptions extends MarketRequestOptions {}

/** Identify a kit to favorite: at least one of `slug` / `kitId`. */
export interface FavoriteTarget {
  slug?: string;
  kitId?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Coerce a raw server favorite record into a {@link Favorite}. Tolerant of
 * missing optional fields; requires a usable `kitId` and `slug` (falling back
 * to one another so a partial record still round-trips for removal).
 */
export function normalizeFavorite(raw: unknown): Favorite | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kitId = asString(record.kitId);
  const slug = asString(record.slug);
  if (!kitId && !slug) return null;
  return {
    kitId: kitId ?? slug!,
    slug: slug ?? kitId!,
    addedAt: asString(record.addedAt) ?? "",
    displayName:
      asString(record.displayName) ?? asString(record.name) ?? undefined,
    summary: asString(record.summary) ?? asString(record.description),
    publisherName:
      asString(record.publisherName) ?? asString(record.publisher)
  };
}

/**
 * List the signed-in user's cloud favorites. GET /api/forge/favorites (Bearer).
 * Returns `{ items: [...] }`; malformed entries are dropped.
 */
export async function listFavorites(
  store: TokenStore,
  options: ListFavoritesOptions
): Promise<Favorite[]> {
  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
  const endpoint = marketBaseUrl + forgeFavoriteRoutes.list();

  const response = await authedRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    })
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Hosted Market could not list favorites. Status: ${response.status}.${
        body ? ` ${body}` : ""
      }`
    );
  }
  const payload = (await response.json()) as { items?: unknown };
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map(normalizeFavorite)
    .filter((f): f is Favorite => f !== null);
}

/**
 * Add a cloud favorite. POST /api/forge/favorites (Bearer) with `{ slug }` or
 * `{ kitId }`. Returns the updated favorite list when the server echoes it,
 * otherwise an empty array (the caller can re-list).
 */
export async function addFavorite(
  store: TokenStore,
  target: FavoriteTarget,
  options: AddFavoriteOptions
): Promise<Favorite[]> {
  const body: { slug?: string; kitId?: string } = {};
  const slug = target.slug?.trim();
  const kitId = target.kitId?.trim();
  if (kitId && kitId.length > 0) {
    body.kitId = kitId;
  } else if (slug && slug.length > 0) {
    body.slug = normalizeMarketIdentifier(slug);
  } else {
    throw new Error("A kit slug or id is required to add a favorite.");
  }

  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
  const endpoint = marketBaseUrl + forgeFavoriteRoutes.list();

  const response = await authedRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    })
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Hosted Market could not add favorite. Status: ${response.status}.${
        detail ? ` ${detail}` : ""
      }`
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    items?: unknown;
  };
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map(normalizeFavorite)
    .filter((f): f is Favorite => f !== null);
}

/**
 * Remove a cloud favorite. DELETE /api/forge/favorites/{kitId} (Bearer).
 */
export async function removeFavorite(
  store: TokenStore,
  kitId: string,
  options: RemoveFavoriteOptions
): Promise<void> {
  const id = kitId?.trim();
  if (!id || id.length === 0) {
    throw new Error("A kit id is required to remove a favorite.");
  }
  const marketBaseUrl = normalizeMarketBaseUrl(options.marketBaseUrl);
  const reqOptions: MarketRequestOptions = { ...options, marketBaseUrl };
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
  const endpoint = marketBaseUrl + forgeFavoriteRoutes.remove(id);

  const response = await authedRequest(store, reqOptions, (token) =>
    fetchImpl(endpoint, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    })
  );
  // Treat 404 as already-removed (idempotent).
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Hosted Market could not remove favorite. Status: ${response.status}.${
        detail ? ` ${detail}` : ""
      }`
    );
  }
}
