// POST /api/stripe/webhook — Stripe webhook endpoint (Gateway 1b-ii).
//
// NO cookie auth — Stripe calls this, not the browser.
// Signature is verified via STRIPE_WEBHOOK_SECRET over the RAW request body.
//
// Handled events:
//   checkout.session.completed  with metadata.kind === "credit_topup"
//     → credits the user's ledger (idempotent via stripe session ID sourceRef).
//
// INERT WITHOUT STRIPE_WEBHOOK_SECRET: returns 503 "payments not configured".
import { handleStripeWebhookCore } from "@/lib/stripe-webhook-core";
import { getStripe, getStripeWebhookSecret, paymentsNotConfiguredResponse } from "@/lib/stripe";
import { devGrantCredits } from "@/server/core/gateway";

// Stripe signs the RAW body; prevent Next from parsing or caching it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleStripeWebhookCore(
    {
      getStripe: () => {
        const stripe = getStripe();
        if (!stripe) return null;
        // Narrow to the shape the webhook core needs (just .webhooks).
        return stripe as typeof stripe & { webhooks: NonNullable<typeof stripe.webhooks> };
      },
      getWebhookSecret: getStripeWebhookSecret,
      topupCredits: async (userId, amountCents, sourceRef) => {
        // devGrantCredits already calls ensureAccount + ledger.topup.
        // The sourceRef ("stripe-topup:{sessionId}") is stored in the txn row
        // for idempotency — the DynamoDB adapter uses a conditional expression
        // that prevents double-applying the same sourceRef.
        await devGrantCredits(userId, amountCents, sourceRef);
      },
      paymentsNotConfigured: paymentsNotConfiguredResponse
    },
    request
  );
}
