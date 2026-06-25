/**
 * Unit tests for the Stripe webhook credit-topup handler (Gateway 1b-ii).
 *
 * Tests the stripe-webhook-core module with mocked deps — no real Stripe client,
 * no DynamoDB. Verifies:
 *   - signature verification failure → 400
 *   - checkout.session.completed with credit_topup metadata → topupCredits called
 *   - idempotency: sourceRef is "stripe-topup:{sessionId}"
 *   - non-credit_topup metadata → ignored (topupCredits NOT called)
 *   - payments not configured (null getStripe) → 503
 *   - best-effort: topupCredits throwing → still returns 200
 */

import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { WebhookCoreDeps } from "@/lib/stripe-webhook-core";
import { handleStripeWebhookCore } from "@/lib/stripe-webhook-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(rawBody: string, signature: string): Request {
  return new Request("https://example.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: rawBody
  });
}

function makeCheckoutEvent(
  metadata: Record<string, string>,
  sessionId = "cs_test_abc123"
): object {
  return {
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        metadata,
        client_reference_id: metadata.userId ?? "user_1"
      }
    }
  };
}

function makeDeps(overrides?: Partial<WebhookCoreDeps>): WebhookCoreDeps & {
  topupCreditsCalls: Array<{ userId: string; amountCents: number; sourceRef: string }>;
} {
  const topupCreditsCalls: Array<{ userId: string; amountCents: number; sourceRef: string }> = [];

  const stripeMock = {
    webhooks: {
      constructEvent: (raw: string, sig: string, _secret: string): Stripe.Event => {
        if (sig === "bad-sig") throw new Error("No signatures found matching the expected signature");
        // Return the parsed raw body as the event (we control it in tests).
        return JSON.parse(raw) as Stripe.Event;
      }
    }
  };

  return {
    topupCreditsCalls,
    getStripe: () => stripeMock,
    getWebhookSecret: () => "whsec_test_secret",
    topupCredits: async (userId, amountCents, sourceRef) => {
      topupCreditsCalls.push({ userId, amountCents, sourceRef });
    },
    paymentsNotConfigured: () =>
      new Response(JSON.stringify({ message: "not configured" }), { status: 503 }),
    ...overrides
  };
}

async function parseJson(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleStripeWebhookCore", () => {
  it("returns 503 when payments not configured (null stripe)", async () => {
    const deps = makeDeps({ getStripe: () => null });
    const res = await handleStripeWebhookCore(deps, makeRequest("{}", "any-sig"));
    expect(res.status).toBe(503);
  });

  it("returns 503 when payments not configured (no webhook secret)", async () => {
    const deps = makeDeps({ getWebhookSecret: () => undefined });
    const res = await handleStripeWebhookCore(deps, makeRequest("{}", "any-sig"));
    expect(res.status).toBe(503);
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const deps = makeDeps();
    const req = new Request("https://example.com/api/stripe/webhook", {
      method: "POST",
      body: "{}"
      // no stripe-signature header
    });
    const res = await handleStripeWebhookCore(deps, req);
    expect(res.status).toBe(400);
    const body = await parseJson(res);
    expect(body).toMatchObject({ message: expect.stringContaining("Missing") });
  });

  it("returns 400 on signature verification failure", async () => {
    const deps = makeDeps();
    const res = await handleStripeWebhookCore(deps, makeRequest("{}", "bad-sig"));
    expect(res.status).toBe(400);
    const body = await parseJson(res);
    expect(body).toMatchObject({ message: expect.stringContaining("signature") });
  });

  it("calls topupCredits with correct args for credit_topup checkout.session.completed", async () => {
    const deps = makeDeps();
    const event = makeCheckoutEvent(
      { kind: "credit_topup", userId: "user_42", creditCents: "1000" },
      "cs_test_session1"
    );
    const raw = JSON.stringify(event);
    const res = await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    expect(res.status).toBe(200);
    expect(await parseJson(res)).toMatchObject({ received: true });
    expect(deps.topupCreditsCalls).toHaveLength(1);
    expect(deps.topupCreditsCalls[0]).toEqual({
      userId: "user_42",
      amountCents: 1000,
      sourceRef: "stripe-topup:cs_test_session1"
    });
  });

  it("idempotency: sourceRef encodes the stripe session ID", async () => {
    const deps = makeDeps();
    const event = makeCheckoutEvent(
      { kind: "credit_topup", userId: "user_7", creditCents: "500" },
      "cs_test_unique_xyz"
    );
    const raw = JSON.stringify(event);

    // Simulate Stripe retrying the webhook twice.
    await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));
    await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    // Both calls reach topupCredits — the ledger's conditional write is
    // responsible for preventing double-credit in production. We confirm the
    // sourceRef is deterministic (same session → same sourceRef).
    expect(deps.topupCreditsCalls).toHaveLength(2);
    expect(deps.topupCreditsCalls[0].sourceRef).toBe("stripe-topup:cs_test_unique_xyz");
    expect(deps.topupCreditsCalls[1].sourceRef).toBe("stripe-topup:cs_test_unique_xyz");
    // Ledger sees the same sourceRef twice and deduplicates at the DB layer.
  });

  it("ignores checkout.session.completed with non-credit_topup metadata", async () => {
    const deps = makeDeps();
    const event = makeCheckoutEvent(
      { kind: "kit_purchase", kitId: "kit_1", userId: "user_1" },
      "cs_test_kit"
    );
    const raw = JSON.stringify(event);
    const res = await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    expect(res.status).toBe(200);
    expect(deps.topupCreditsCalls).toHaveLength(0);
  });

  it("ignores events that are not checkout.session.completed", async () => {
    const deps = makeDeps();
    const event = {
      id: "evt_2",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1" } }
    };
    const raw = JSON.stringify(event);
    const res = await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    expect(res.status).toBe(200);
    expect(deps.topupCreditsCalls).toHaveLength(0);
  });

  it("returns 200 (best-effort) even when topupCredits throws", async () => {
    const deps = makeDeps({
      topupCredits: async () => {
        throw new Error("DynamoDB connection error");
      }
    });
    const event = makeCheckoutEvent(
      { kind: "credit_topup", userId: "user_1", creditCents: "500" },
      "cs_test_err"
    );
    const raw = JSON.stringify(event);
    const res = await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    // Must return 200 — Stripe would retry on non-2xx, causing double-credits.
    expect(res.status).toBe(200);
    expect(await parseJson(res)).toMatchObject({ received: true });
  });

  it("skips topup when metadata is missing userId", async () => {
    const deps = makeDeps();
    const event = makeCheckoutEvent(
      { kind: "credit_topup", creditCents: "500" }, // no userId
      "cs_test_no_user"
    );
    const raw = JSON.stringify(event);
    const res = await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    expect(res.status).toBe(200);
    expect(deps.topupCreditsCalls).toHaveLength(0);
  });

  it("skips topup when creditCents is not a valid positive number", async () => {
    const deps = makeDeps();
    const event = makeCheckoutEvent(
      { kind: "credit_topup", userId: "user_1", creditCents: "not-a-number" },
      "cs_test_bad_cents"
    );
    const raw = JSON.stringify(event);
    const res = await handleStripeWebhookCore(deps, makeRequest(raw, "good-sig"));

    expect(res.status).toBe(200);
    expect(deps.topupCreditsCalls).toHaveLength(0);
  });
});
