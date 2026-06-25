// Inert stub — real logic in the optional @agentkit-commercial/market-web pkg.
import { commercialHandlerOr503 } from "@/lib/commercial";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ orgId: string }> };

const handle = commercialHandlerOr503("browserOnboardOrgPayouts");

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return handle(request, orgId);
}
