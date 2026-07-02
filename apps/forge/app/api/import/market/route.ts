// POST /api/import/market -> importHostedMarketKit
// body: { slug, kitId?, marketBaseUrl? }
import { withUser } from "@/lib/api";
import { importFromMarket } from "@/server/core/import-ops";
import { getMarketBaseUrl } from "@/lib/self-host";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUser(async (user) => {
    const body = (await request.json()) as { slug?: string; kitId?: string; marketBaseUrl?: string };
    if (!body.slug) throw new Error("slug is required.");
    // Resolve a Market URL: caller override, else the instance Market. With no
    // Market configured (self-host without a Market) refuse — never phone home.
    const marketBaseUrl = body.marketBaseUrl ?? getMarketBaseUrl();
    if (!marketBaseUrl) {
      return NextResponse.json(
        { error: "Market import is not available on this instance." },
        { status: 404 }
      );
    }
    return importFromMarket(user.id, {
      slug: body.slug,
      kitId: body.kitId,
      marketBaseUrl
    });
  });
}
