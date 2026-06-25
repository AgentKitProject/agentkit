// POST /api/credits/topup — create a Stripe Checkout Session for a prepaid
// credit top-up. Requires an authenticated WorkOS session.
//
// Body: { amountCents: number }  — must be one of TOP_UP_PRESETS_CENTS.
// Returns: { url: string }  — redirect the browser here to start payment.
//
// On payment completion, Stripe calls POST /api/stripe/webhook which credits
// the ledger (checkout.session.completed + metadata.kind === "credit_topup").
//
// INERT WITHOUT STRIPE_SECRET_KEY: returns 503 "payments not configured".
// Does NOT crash build or SSR when Stripe env is absent.
import { withUser, jsonError } from "@/lib/api";
import { getStripe, paymentsNotConfiguredResponse } from "@/lib/stripe";
import { getAppUrl } from "@/lib/url-config";
import { TOP_UP_PRESETS_CENTS } from "@/lib/topup-presets";

export const dynamic = "force-dynamic";

const PRESETS_SET = new Set<number>(TOP_UP_PRESETS_CENTS);
const MIN_TOP_UP_CENTS = Math.min(...TOP_UP_PRESETS_CENTS);

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function POST(request: Request) {
  const stripe = getStripe();
  if (!stripe) return paymentsNotConfiguredResponse();

  return withUser(async (user) => {
    const body = (await request.json().catch(() => ({}))) as { amountCents?: unknown };
    const amountCents = typeof body.amountCents === "number" ? Math.floor(body.amountCents) : NaN;

    if (!Number.isFinite(amountCents) || amountCents < MIN_TOP_UP_CENTS) {
      return jsonError(
        `amountCents must be one of: ${TOP_UP_PRESETS_CENTS.map(formatDollars).join(", ")}.`,
        400
      );
    }
    if (!PRESETS_SET.has(amountCents)) {
      return jsonError(
        `Invalid top-up amount. Choose one of: ${TOP_UP_PRESETS_CENTS.map(formatDollars).join(", ")}.`,
        400
      );
    }

    const appUrl = getAppUrl();
    // Return to Settings/Build with a query param so the UI can show a confirmation.
    const successUrl = `${appUrl}/forge?topup=success`;
    const cancelUrl = `${appUrl}/forge?topup=cancelled`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Web Forge Credits — ${formatDollars(amountCents)}`,
              description:
                "Prepaid credits for managed AI inference on Web Forge. Credits are non-refundable and never expire."
            }
          }
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: user.id,
      // Metadata carried through to the webhook so it can identify and credit
      // the right user/amount without re-parsing the line items.
      metadata: {
        kind: "credit_topup",
        userId: user.id,
        creditCents: String(amountCents)
      }
    });

    if (!session.url) {
      return jsonError("Stripe did not return a checkout URL.", 502);
    }

    return { url: session.url };
  });
}
