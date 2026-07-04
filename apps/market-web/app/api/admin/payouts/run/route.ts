// Inert stub — real logic in the optional @agentkit-commercial/market-web pkg.
// M6 P2: periodic seller payout job. Admin-key-gated inside the commercial
// handler (requireAdminForApi). Absent on the public/self-host build → 503.
import { commercialHandlerOr503 } from "@/lib/commercial";

export const dynamic = "force-dynamic";

const handle = commercialHandlerOr503("adminRunSellerPayouts");

export async function POST(request: Request) {
  return handle(request);
}
