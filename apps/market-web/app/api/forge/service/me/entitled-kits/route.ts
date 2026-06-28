// POST /api/forge/service/me/entitled-kits — SERVICE-KEY authed listing of the
// asserted user's PROTECTED (paid + non-downloadable) entitled kits, browser-safe
// (name/slug/marketKitId only). Used by the hosted AgentKitAuto SSR server to
// offer a "run on Auto" picker. THIRD auth path: service key only (NOT
// requireForgeUser, NOT the AuthKit cookie). Real logic lives in the optional
// @agentkit-commercial/market-web package (lib/service-entitlements.ts +
// the app-owned lib/service-auth.ts which STAYS public). Inert 503 without it.
import { commercialHandlerOr503 } from "@/lib/commercial";

export const dynamic = "force-dynamic";

const handle = commercialHandlerOr503("serviceListEntitledKits");

export async function POST(request: Request) {
  return handle(request);
}
