// Inert stub for the commercial Stripe webhook handler. The real logic lives in
// the optional `@agentkit-commercial/market-web` package; without it this route
// returns 503 { error: "commerce_disabled" }. See lib/commercial.ts.
import { commercialHandlerOr503 } from "@/lib/commercial";

// Stripe signs the RAW body; never let Next parse/cache it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = commercialHandlerOr503("handleStripeWebhook");

export async function POST(request: Request) {
  return handle(request);
}
