// GET    /api/favorites -> listFavorites
// POST   /api/favorites -> addFavorite     body: { marketSlug, marketKitId, ... }
// DELETE /api/favorites -> removeFavorite   body: { marketSlug }
//
// Favorites are now stored in the Market cloud favorites API
// (GET/POST https://market.agentkitproject.com/api/forge/favorites,
//  DELETE /api/forge/favorites/{kitId}) so they sync across web + desktop
// for the same WorkOS identity.
//
// Requires a signed-in session with a valid WorkOS access token. Returns 401
// with a user-visible message when no access token is available.
import { withUser } from "@/lib/api";
import { getWorkosAccessToken } from "@/server/core/market-auth";
import { getMarketBaseUrl } from "@/lib/self-host";
import { NextResponse } from "next/server";
import type { FavoriteRecord } from "@/server/store/types";

export const dynamic = "force-dynamic";

/**
 * Resolve the Market base URL, or return null. Favorites live in the Market
 * cloud API, so with no Market configured (self-host without a Market) there is
 * nowhere to sync — we return an empty/disabled response, never the hosted URL.
 */
function marketBaseUrlOrNull(): string | null {
  return getMarketBaseUrl() ?? null;
}

/** Clean "favorites unavailable" response when no Market is configured. */
function marketDisabledResponse(): NextResponse {
  return NextResponse.json(
    { favorites: [], disabled: true, error: "Cloud favorites are not available on this instance." },
    { status: 200 }
  );
}

/** Wrapper: get the access token or return a 401 response. */
async function withToken<T>(
  handler: (token: string, marketBaseUrl: string) => Promise<T>
): Promise<NextResponse> {
  const MARKET_BASE_URL = marketBaseUrlOrNull();
  if (!MARKET_BASE_URL) {
    return marketDisabledResponse();
  }
  const token = await getWorkosAccessToken();
  if (!token) {
    return NextResponse.json(
      {
        error:
          "You must be signed in to AgentKitProject to sync favorites across devices. Please sign in and try again."
      },
      { status: 401 }
    );
  }
  try {
    const result = await handler(token, MARKET_BASE_URL);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Map a Market API favorites item to the FavoriteRecord shape the UI expects. */
function mapItem(item: Record<string, unknown>, marketBaseUrl: string): FavoriteRecord {
  return {
    marketKitId: (item.kitId as string | undefined) ?? (item.marketKitId as string | undefined),
    marketSlug: (item.slug as string | undefined) ?? (item.marketSlug as string),
    marketBaseUrl: (item.marketBaseUrl as string | undefined) ?? marketBaseUrl,
    displayName: item.displayName as string | undefined,
    publisher: item.publisher as string | undefined,
    version: item.version as string | undefined,
    addedAt: (item.addedAt as string | undefined) ?? new Date().toISOString()
  };
}

export async function GET() {
  return withUser(async () => {
    return withToken(async (token, marketBaseUrl) => {
      const res = await fetch(`${marketBaseUrl}/api/forge/favorites`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Market favorites fetch failed (${res.status}): ${body}`);
      }
      const data = (await res.json()) as { items: Record<string, unknown>[] };
      const favorites: FavoriteRecord[] = (data.items ?? []).map((i) => mapItem(i, marketBaseUrl));
      return { favorites };
    });
  });
}

export async function POST(request: Request) {
  return withUser(async () => {
    const body = (await request.json()) as {
      marketSlug?: string;
      marketKitId?: string;
    };
    if (!body.marketSlug && !body.marketKitId) {
      return NextResponse.json({ error: "marketSlug or marketKitId is required." }, { status: 400 });
    }
    return withToken(async (token, marketBaseUrl) => {
      const payload: Record<string, string> = {};
      if (body.marketSlug) payload.slug = body.marketSlug;
      if (body.marketKitId) payload.kitId = body.marketKitId;
      const res = await fetch(`${marketBaseUrl}/api/forge/favorites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Market add-favorite failed (${res.status}): ${errBody}`);
      }
      const data = (await res.json()) as { item?: Record<string, unknown> };
      const favorite: FavoriteRecord = data.item
        ? mapItem(data.item, marketBaseUrl)
        : {
            marketKitId: body.marketKitId,
            marketSlug: body.marketSlug ?? "",
            marketBaseUrl,
            addedAt: new Date().toISOString()
          };
      return { favorite };
    });
  });
}

export async function DELETE(request: Request) {
  return withUser(async () => {
    const body = (await request.json()) as { marketSlug?: string; marketKitId?: string };
    const kitId = body.marketKitId ?? body.marketSlug;
    if (!kitId) {
      return NextResponse.json({ error: "marketSlug or marketKitId is required." }, { status: 400 });
    }
    return withToken(async (token, marketBaseUrl) => {
      const res = await fetch(
        `${marketBaseUrl}/api/forge/favorites/${encodeURIComponent(kitId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Market remove-favorite failed (${res.status}): ${errBody}`);
      }
      return { ok: true };
    });
  });
}
