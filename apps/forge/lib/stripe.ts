/**
 * Lazily-initialized server-only Stripe client for Web Forge prepaid credit
 * top-ups (Gateway 1b-ii).
 *
 * INERT WITHOUT KEYS: if `STRIPE_SECRET_KEY` is absent (the default until the
 * keys are provisioned in Amplify), `getStripe()` returns null and the
 * checkout/webhook routes return a clear 503 "payments not configured".
 * The build and SSR never crash on a missing key.
 *
 * Stripe lives ONLY in this file and the two route files — never in
 * @agentkitforge/gateway-core (which stays payment-provider-agnostic).
 * Secrets are server-only; never prefix with NEXT_PUBLIC_.
 */

import Stripe from "stripe";
import { NextResponse } from "next/server";

let cached: Stripe | null | undefined;

/** Returns a configured Stripe client, or null when payments are not configured. */
export function getStripe(): Stripe | null {
  if (cached !== undefined) {
    return cached;
  }
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || secretKey.trim().length === 0) {
    cached = null;
    return cached;
  }
  cached = new Stripe(secretKey, {
    // Pin a stable API version; bump deliberately when upgrading the SDK.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiVersion: "2026-05-27.dahlia" as any,
    appInfo: { name: "agentkitforge" }
  });
  return cached;
}

/** The webhook signing secret, or undefined when not configured. */
export function getStripeWebhookSecret(): string | undefined {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  return secret && secret.trim().length > 0 ? secret : undefined;
}

/** Whether Stripe checkout is configured (secret key present). */
export function isStripeConfigured(): boolean {
  return getStripe() !== null;
}

/** Standard 503 response for payment routes when Stripe is not configured. */
export function paymentsNotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { message: "Payments are not configured on this Forge instance." },
    { status: 503 }
  );
}

/** Reset the cached client — test-only seam. */
export function __resetStripeForTests(): void {
  cached = undefined;
}
