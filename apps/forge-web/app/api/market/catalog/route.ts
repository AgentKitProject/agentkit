// GET /api/market/catalog?q=...&cursor=...&limit=...
// Proxy for the public Market kit catalog. The Market's public GET /kits
// endpoint is unauthenticated — we proxy it here so the web UI doesn't
// hard-code the Market origin and so we can add pagination/search shaping.
// requireUserForApi is called to ensure only logged-in users browse.
import { withUser } from "@/lib/api";
import { getMarketBaseUrl } from "@/lib/self-host";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async () => {
    // Market disabled / no Market URL configured (self-host without a Market):
    // return an empty catalog rather than silently phoning the hosted Market.
    const MARKET_BASE = getMarketBaseUrl();
    if (!MARKET_BASE) {
      return { kits: [], nextCursor: null };
    }
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim() ?? "";
    const cursor = searchParams.get("cursor") ?? "";
    const limit = Math.min(Number(searchParams.get("limit") ?? "24"), 50);

    // Forward to Market public catalog
    const upstreamParams = new URLSearchParams();
    if (q) upstreamParams.set("q", q);
    if (cursor) upstreamParams.set("cursor", cursor);
    upstreamParams.set("limit", String(limit));

    const url = `${MARKET_BASE}/api/kits?${upstreamParams}`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      // 10-second timeout via AbortSignal
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      // Surface a clear error without leaking upstream internals
      throw new Error(`Market catalog request failed (${res.status})`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    // Normalize: some Market API versions return { kits: [...], nextCursor }
    // others return { items: [...], next_cursor }. Flatten to { kits, nextCursor }.
    const kits = (data.kits ?? data.items ?? []) as unknown[];
    const nextCursor = (data.nextCursor ?? data.next_cursor ?? null) as string | null;

    return { kits, nextCursor };
  });
}
