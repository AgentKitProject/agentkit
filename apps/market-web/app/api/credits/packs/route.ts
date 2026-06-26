// Inert stub — real logic in the optional @agentkit-commercial/market-web pkg.
import { commercialHandlerOr503 } from "@/lib/commercial";

export const dynamic = "force-dynamic";

const handle = commercialHandlerOr503("listCreditPacks");

export async function GET(request: Request) {
  return handle(request);
}
