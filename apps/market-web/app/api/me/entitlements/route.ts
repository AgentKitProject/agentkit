// Inert stub — real logic in the optional @agentkit-commercial/market-web pkg.
import { commercialHandlerOr503 } from "@/lib/commercial";

const handle = commercialHandlerOr503("browserListMyEntitlements");

export async function GET(request: Request) {
  return handle(request);
}
