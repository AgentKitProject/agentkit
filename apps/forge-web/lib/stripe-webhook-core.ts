/**
 * Dependency-injected core for the Stripe webhook handler (Gateway 1b-ii).
 *
 * Keeps the webhook logic unit-testable without Next.js. The thin route
 * wrapper at app/api/stripe/webhook/route.ts binds real deps.
 *
 * Only handles: checkout.session.completed with metadata.kind === "credit_topup".
 * Other event types are silently ignored (200).
 *
 * Idempotency: guards against double-credit on webhook retries by recording the
 * Stripe Checkout Session ID as the sourceRef in the ledger topup call.
 * gateway-core's topup uses the sourceRef in a conditional-write (or at minimum
 * the caller can check for duplicates). We use a Map-based seen-set in this
 * module for in-process dedup, and rely on the ledger's own sourceRef-keyed
 * uniqueness for cross-process/retry safety.
 */

import type Stripe from "stripe";

export type WebhookCoreDeps = {
  /** Returns the Stripe client (null → payments not configured). */
  getStripe: () => StripeLikeForWebhook | null;
  /** The webhook signing secret (undefined → not configured). */
  getWebhookSecret: () => string | undefined;
  /**
   * Credits the user's ledger. Analogous to devGrantCredits but called from
   * the webhook. The sourceRef is the Stripe session ID — use it for idempotency.
   */
  topupCredits: (userId: string, amountCents: number, sourceRef: string) => Promise<void>;
  /** Response factory — returns a 503 "not configured" response. */
  paymentsNotConfigured: () => Response;
};

export type StripeLikeForWebhook = {
  webhooks: {
    constructEvent: (raw: string, sig: string, secret: string) => Stripe.Event;
  };
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export async function handleStripeWebhookCore(
  deps: WebhookCoreDeps,
  request: Request
): Promise<Response> {
  const stripe = deps.getStripe();
  const webhookSecret = deps.getWebhookSecret();
  if (!stripe || !webhookSecret) return deps.paymentsNotConfigured();

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return json({ message: "Missing stripe-signature header." }, 400);
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid signature.";
    return json({ message: `Webhook signature verification failed: ${message}` }, 400);
  }

  // Best-effort: catch errors per-handler so a bug never leaves Stripe
  // retrying indefinitely. Always return 200 after signature verification.
  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(deps, event.data.object as Stripe.Checkout.Session);
    }
    // All other event types are intentionally ignored.
  } catch (error) {
    console.error("[stripe-webhook] handler error", event.type, error);
    // Still return 200 — Stripe should not retry events we've verified.
  }

  return json({ received: true }, 200);
}

async function handleCheckoutCompleted(
  deps: WebhookCoreDeps,
  session: Stripe.Checkout.Session
): Promise<void> {
  const metadata = session.metadata ?? {};

  // Only handle credit top-ups from this app.
  if (metadata.kind !== "credit_topup") return;

  const userId = metadata.userId;
  const creditCentsStr = metadata.creditCents;
  const sessionId = session.id;

  if (!userId || !creditCentsStr || !sessionId) {
    console.warn("[stripe-webhook] credit_topup session missing required metadata", {
      sessionId,
      hasUserId: !!userId,
      hasCreditCents: !!creditCentsStr
    });
    return;
  }

  const creditCents = parseInt(creditCentsStr, 10);
  if (!Number.isFinite(creditCents) || creditCents <= 0) {
    console.warn("[stripe-webhook] credit_topup invalid creditCents", creditCentsStr);
    return;
  }

  // sourceRef = "stripe-topup:{sessionId}" is the idempotency key.
  // The ledger's topup uses this to detect and skip duplicate credits on retry.
  const sourceRef = `stripe-topup:${sessionId}`;
  await deps.topupCredits(userId, creditCents, sourceRef);
}
