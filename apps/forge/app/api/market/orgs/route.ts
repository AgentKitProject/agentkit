// GET /api/market/orgs
//
// Lists the WorkOS organizations the current user belongs to by proxying
// GET /api/forge/orgs on the hosted Market. Requires a valid WorkOS access
// token (the user must be signed in). Returns { orgs: OrgEntry[] }.
//
// Per-org kit listings are NOT yet available: Market Phase 2 (private catalogs
// + org-owned kits) is still in progress. This route returns membership data
// only, so the UI can surface the org list and explain the gap.
import { withUser } from "@/lib/api";
import { getWorkosAccessToken } from "@/server/core/market-auth";
import { getMarketBaseUrl } from "@/lib/self-host";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser(async () => {
    // Market disabled / no Market URL: no orgs to list, never phone home.
    const MARKET_BASE = getMarketBaseUrl();
    if (!MARKET_BASE) {
      return { orgs: [] };
    }
    const token = await getWorkosAccessToken();
    if (!token) {
      return NextResponse.json({ error: "Not signed in to AgentKitProject." }, { status: 401 });
    }

    const url = `${MARKET_BASE}/api/forge/orgs`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Network error reaching Market.";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ error: "Market authentication failed. Please sign out and back in." }, { status: 401 });
      }
      return NextResponse.json({ error: `Market returned ${res.status}.` }, { status: res.status });
    }

    const data = (await res.json()) as unknown;
    // Market returns { orgs: [...] } — pass through as-is.
    return data;
  });
}
