// GET /api/market/orgs/[orgId]/kits
//
// Lists all kits owned by an org (including private) by proxying
// GET /api/forge/orgs/{orgId}/kits on the hosted Market.
//
// Auth: WorkOS cookie session (same token forwarded to Market as Bearer).
// The Market /api/forge/orgs/{orgId}/kits route uses requireForgeUser and
// checks that the calling user is an active member of the org — so private
// kits are only returned to members.
import { withUser } from "@/lib/api";
import { getWorkosAccessToken } from "@/server/core/market-auth";
import { getMarketBaseUrl } from "@/lib/self-host";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await params;
  return withUser(async () => {
    const MARKET_BASE = getMarketBaseUrl();
    if (!MARKET_BASE) {
      return { items: [] };
    }
    const token = await getWorkosAccessToken();
    if (!token) {
      return NextResponse.json({ error: "Not signed in to AgentKitProject." }, { status: 401 });
    }

    const url = `${MARKET_BASE}/api/forge/orgs/${encodeURIComponent(orgId)}/kits`;
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
        return NextResponse.json(
          { error: "Not authorized to view this organization's kits. Make sure you are an active member." },
          { status: res.status }
        );
      }
      return NextResponse.json({ error: `Market returned ${res.status}.` }, { status: res.status });
    }

    const data = (await res.json()) as unknown;
    // Market returns { items: [...] } — pass through as-is.
    return data;
  });
}
