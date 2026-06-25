// POST /api/forge/service/kits/[slug]/licensed-package — SERVICE-KEY authed,
// entitlement-gated licensed-package resolution for the hosted AgentKitAuto
// worker path. THIRD auth path: service key only (NOT requireForgeUser, NOT the
// AuthKit cookie). Real logic lives in the optional
// @agentkit-commercial/market-web package (lib/service-pricing.ts +
// the app-owned lib/service-auth.ts which STAYS public). Inert 503 without it.
import { commercialHandlerOr503 } from "@/lib/commercial";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string }> };

const handle = commercialHandlerOr503("serviceLicensedPackage");

export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params;
  return handle(request, slug);
}
