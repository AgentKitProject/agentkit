// GET /api/kits/update-check?marketBaseUrl&slug&installedVersion
//   -> checkKitUpdate (core market client, read-only/tokenless).
//
// Surfaces "update available" for favorited/imported Market kits. Never throws
// on network/parse failure — the core helper degrades to `reason: "error"`.
import { withUser } from "@/lib/api";
import { loadCoreMarket } from "@/server/core/load-core";
import { getMarketBaseUrl } from "@/lib/self-host";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async () => {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    if (!slug) throw new Error("slug is required.");
    // Resolve a Market URL: query override, else the instance Market. With no
    // Market configured, report "disabled" instead of checking the hosted Market.
    const marketBaseUrl = url.searchParams.get("marketBaseUrl") || getMarketBaseUrl();
    if (!marketBaseUrl) {
      return { reason: "disabled" as const, updateAvailable: false };
    }
    const installedVersion = url.searchParams.get("installedVersion") || "1";
    const market = await loadCoreMarket();
    return market.checkKitUpdate({
      slug,
      marketBaseUrl,
      installedVersion
    });
  });
}
