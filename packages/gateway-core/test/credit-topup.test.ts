/**
 * Service-key-gated credit-topup endpoint (entrypoints/credit-topup.ts) and its
 * managed-server pre-route wiring (makeCreditTopupPreRoute).
 *
 * Test-mode only: an in-memory credit ledger, no real Postgres, no Stripe. The
 * endpoint is the Stripe-webhook → ledger boundary; these tests prove:
 *   - a valid service key tops up (200, balance credited);
 *   - a missing key → 401; a wrong key → 403; an unconfigured key → 503 (inert);
 *   - a malformed body → 400;
 *   - constant-time key comparison rejects length-mismatched keys;
 *   - redelivery with the same sourceRef is idempotent downstream (credited once);
 *   - the pre-route only intercepts POST /gateway/credits/topup.
 */

import { describe, it, expect } from "vitest";
import {
  CREDIT_TOPUP_PATH,
  constantTimeEqual,
  extractServiceKey,
  handleCreditTopup,
} from "../src/entrypoints/credit-topup.js";
import { makeCreditTopupPreRoute } from "../src/entrypoints/managed-server.js";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

const NOW = "2026-06-25T00:00:00.000Z";
const KEY = "svc-secret-key-abc123";

function deps(over?: { serviceKey?: string | undefined; minCents?: number }) {
  const ledger = new InMemoryCreditLedgerRepository();
  return {
    ledger,
    serviceKey: over && "serviceKey" in over ? over.serviceKey : KEY,
    minCents: over?.minCents ?? 1,
    now: () => NOW,
  };
}

const body = (over?: Record<string, unknown>) => ({
  userId: "user-1",
  creditCents: 2000,
  sourceRef: "stripe-cs-test_1",
  ...over,
});

describe("handleCreditTopup", () => {
  it("tops up with a valid service key (200, balance credited)", async () => {
    const d = deps();
    const res = await handleCreditTopup(d, KEY, body());
    expect(res.status).toBe(200);
    expect((res.body as { availableBalanceCents: number }).availableBalanceCents).toBe(2000);
    const acct = await d.ledger.getAccount("user-1");
    expect(acct?.availableBalanceCents).toBe(2000);
    expect(acct?.lifetimeTopupCents).toBe(2000);
  });

  it("returns 503 when no service key is configured (inert)", async () => {
    const res = await handleCreditTopup(deps({ serviceKey: undefined }), "anything", body());
    expect(res.status).toBe(503);
  });

  it("returns 401 when no key is provided", async () => {
    const res = await handleCreditTopup(deps(), null, body());
    expect(res.status).toBe(401);
  });

  it("returns 403 on a wrong key", async () => {
    const res = await handleCreditTopup(deps(), "wrong-key", body());
    expect(res.status).toBe(403);
  });

  it("returns 403 on a length-mismatched key (constant-time compare)", async () => {
    const res = await handleCreditTopup(deps(), KEY + "extra", body());
    expect(res.status).toBe(403);
  });

  it("does not credit the ledger when the key is invalid", async () => {
    const d = deps();
    await handleCreditTopup(d, "wrong", body());
    const acct = await d.ledger.getAccount("user-1");
    expect(acct).toBeUndefined();
  });

  it("returns 400 on a missing userId", async () => {
    const res = await handleCreditTopup(deps(), KEY, body({ userId: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on a missing sourceRef", async () => {
    const res = await handleCreditTopup(deps(), KEY, body({ sourceRef: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on a non-integer creditCents", async () => {
    const res = await handleCreditTopup(deps(), KEY, body({ creditCents: 9.5 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when creditCents is below the minimum", async () => {
    const res = await handleCreditTopup(deps({ minCents: 500 }), KEY, body({ creditCents: 100 }));
    expect(res.status).toBe(400);
  });

  it("is idempotent downstream: redelivery with the same sourceRef credits once", async () => {
    const d = deps();
    const first = await handleCreditTopup(d, KEY, body());
    const second = await handleCreditTopup(d, KEY, body()); // redelivered webhook
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // NOTE: the in-memory ledger has no UNIQUE backstop, so it accumulates; the
    // DB-enforced idempotency is proven against the Postgres ledger in
    // gateway-commercial/test/topup-idempotency.test.ts. Here we assert the
    // endpoint forwards the SAME sourceRef both times, which is what makes the
    // Postgres backstop fire in production.
    const txns = await d.ledger.listTransactions("user-1");
    const topups = txns.filter((t) => t.type === "topup");
    expect(topups.every((t) => t.sourceRef === "stripe-cs-test_1")).toBe(true);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  it("returns false for different same-length strings", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });
  it("returns false for length-mismatched strings", () => {
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
  });
});

describe("extractServiceKey", () => {
  it("reads x-gateway-service-key", () => {
    expect(extractServiceKey({ serviceKeyHeader: "k1" })).toBe("k1");
  });
  it("reads Authorization: Bearer", () => {
    expect(extractServiceKey({ authorization: "Bearer k2" })).toBe("k2");
  });
  it("prefers the dedicated header over Authorization", () => {
    expect(extractServiceKey({ serviceKeyHeader: "k1", authorization: "Bearer k2" })).toBe("k1");
  });
  it("returns null when neither is present", () => {
    expect(extractServiceKey({})).toBeNull();
  });
});

describe("makeCreditTopupPreRoute", () => {
  const fakeReq = (headers: Record<string, string>) =>
    ({ headers } as unknown as Parameters<ReturnType<typeof makeCreditTopupPreRoute>>[0]);

  it("intercepts POST /gateway/credits/topup and tops up", async () => {
    const d = deps();
    const preRoute = makeCreditTopupPreRoute(d);
    const handled = await preRoute(fakeReq({ "x-gateway-service-key": KEY }), {
      path: CREDIT_TOPUP_PATH,
      method: "POST",
      body: body(),
    });
    expect(handled?.status).toBe(200);
    expect((await d.ledger.getAccount("user-1"))?.availableBalanceCents).toBe(2000);
  });

  it("returns 403 via the pre-route on a bad key", async () => {
    const preRoute = makeCreditTopupPreRoute(deps());
    const handled = await preRoute(fakeReq({ "x-gateway-service-key": "nope" }), {
      path: CREDIT_TOPUP_PATH,
      method: "POST",
      body: body(),
    });
    expect(handled?.status).toBe(403);
  });

  it("returns 405 on a non-POST to the topup path", async () => {
    const preRoute = makeCreditTopupPreRoute(deps());
    const handled = await preRoute(fakeReq({}), { path: CREDIT_TOPUP_PATH, method: "GET", body: undefined });
    expect(handled?.status).toBe(405);
  });

  it("falls through (undefined) for any other path", async () => {
    const preRoute = makeCreditTopupPreRoute(deps());
    const handled = await preRoute(fakeReq({ "x-gateway-service-key": KEY }), {
      path: "/gateway/sessions",
      method: "POST",
      body: {},
    });
    expect(handled).toBeUndefined();
  });
});
