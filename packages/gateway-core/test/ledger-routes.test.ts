/**
 * Service-key-gated credit-LEDGER endpoints (entrypoints/ledger-routes.ts) and
 * their managed-server pre-route wiring (makeLedgerPreRoute).
 *
 * These are the HTTP seam AgentKitAuto uses to debit/hold/settle the credit
 * ledger over the network instead of a direct DB connection. Test-mode only: an
 * in-memory credit ledger, no real Postgres. The tests prove:
 *   - auth: 503 (unconfigured) / 401 (missing key) / 403 (wrong key) precede
 *     every route, just like credit-topup;
 *   - each route calls the injected ledger with the right args + server-stamped
 *     now, and shapes the response;
 *   - idempotent sourceRef / runId pass through;
 *   - insufficient balance → 402; missing account → 404;
 *   - the rates endpoint returns the INJECTED pricing, and all-zeros when no
 *     pricing provider is injected (public / self-host gateway);
 *   - the pre-route only intercepts /gateway/ledger/* and parses the query.
 */

import { describe, it, expect } from "vitest";
import {
  LEDGER_ROUTE_PREFIX,
  handleLedgerRequest,
  type AutoV2PricingShape,
} from "../src/entrypoints/ledger-routes.js";
import { makeLedgerPreRoute } from "../src/entrypoints/managed-server.js";
import { FREE_TRIAL_PERIOD_KEY } from "../src/core/services/affordability.js";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

const NOW = "2026-06-25T00:00:00.000Z";
const KEY = "svc-secret-key-abc123";

function makeDeps(over?: {
  serviceKey?: string | undefined;
  autoV2Pricing?: () => AutoV2PricingShape;
  managedInferenceFloorCents?: number;
}) {
  const ledger = new InMemoryCreditLedgerRepository();
  return {
    ledger,
    serviceKey: over && "serviceKey" in over ? over.serviceKey : KEY,
    now: () => NOW,
    ...(over?.autoV2Pricing ? { autoV2Pricing: over.autoV2Pricing } : {}),
    ...(over?.managedInferenceFloorCents !== undefined
      ? { managedInferenceFloorCents: over.managedInferenceFloorCents }
      : {}),
  };
}

const q = (s = "") => new URLSearchParams(s);

function call(
  deps: ReturnType<typeof makeDeps>,
  key: string | null | undefined,
  path: string,
  method: string,
  body?: unknown,
  query?: string,
) {
  return handleLedgerRequest(deps, key, {
    path: `${LEDGER_ROUTE_PREFIX}${path}`,
    method,
    body,
    query: q(query),
  });
}

// ---------------------------------------------------------------------------
// Auth gate (shared by every route)
// ---------------------------------------------------------------------------

describe("ledger routes auth", () => {
  it("returns 503 when no service key is configured (inert)", async () => {
    const res = await call(makeDeps({ serviceKey: undefined }), "anything", "/ensure-account", "POST", {
      userId: "u1",
    });
    expect(res.status).toBe(503);
  });

  it("returns 401 when no key is provided", async () => {
    const res = await call(makeDeps(), null, "/ensure-account", "POST", { userId: "u1" });
    expect(res.status).toBe(401);
  });

  it("returns 403 on a wrong key", async () => {
    const res = await call(makeDeps(), "nope", "/ensure-account", "POST", { userId: "u1" });
    expect(res.status).toBe(403);
  });

  it("returns 403 on a length-mismatched key (constant-time compare)", async () => {
    const res = await call(makeDeps(), KEY + "x", "/ensure-account", "POST", { userId: "u1" });
    expect(res.status).toBe(403);
  });

  it("does not touch the ledger when the key is invalid", async () => {
    const d = makeDeps();
    await call(d, "wrong", "/debit", "POST", { userId: "u1", amountCents: 100 });
    expect(await d.ledger.getAccount("u1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureAccount / getAccount
// ---------------------------------------------------------------------------

describe("ensure-account + account", () => {
  it("ensures an account and returns its snapshot", async () => {
    const d = makeDeps();
    const res = await call(d, KEY, "/ensure-account", "POST", { userId: "u1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: "u1", availableBalanceCents: 0, updatedAt: NOW });
    expect(await d.ledger.getAccount("u1")).toBeDefined();
  });

  it("400 when userId is missing", async () => {
    const res = await call(makeDeps(), KEY, "/ensure-account", "POST", {});
    expect(res.status).toBe(400);
  });

  it("getAccount returns the account from the query param", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 500, NOW);
    const res = await call(d, KEY, "/account", "GET", undefined, "userId=u1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: "u1", availableBalanceCents: 500 });
  });

  it("getAccount 404 when the account does not exist", async () => {
    const res = await call(makeDeps(), KEY, "/account", "GET", undefined, "userId=ghost");
    expect(res.status).toBe(404);
  });

  it("getAccount 400 when userId query param is missing", async () => {
    const res = await call(makeDeps(), KEY, "/account", "GET", undefined, "");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// debit (server-stamped now, idempotent sourceRef)
// ---------------------------------------------------------------------------

describe("debit", () => {
  it("debits the balance and stamps now server-side", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 1000, NOW);
    const res = await call(d, KEY, "/debit", "POST", {
      userId: "u1",
      amountCents: 1,
      description: "invocation",
      sourceRef: "auto-invocation-r1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ availableBalanceCents: 999 });
    const txns = await d.ledger.listTransactions("u1");
    const debit = txns.find((t) => t.type === "debit");
    expect(debit?.sourceRef).toBe("auto-invocation-r1");
    expect(debit?.createdAt).toBe(NOW); // server-stamped, not from the body
  });

  it("402 on insufficient balance", async () => {
    const res = await call(makeDeps(), KEY, "/debit", "POST", { userId: "u1", amountCents: 100 });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: "insufficient_balance" });
  });

  it("400 on a non-integer amount", async () => {
    const res = await call(makeDeps(), KEY, "/debit", "POST", { userId: "u1", amountCents: 1.5 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// holds: reserve / settle / release
// ---------------------------------------------------------------------------

describe("holds", () => {
  it("reserves a hold and returns its id", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 1000, NOW);
    const res = await call(d, KEY, "/holds", "POST", { userId: "u1", maxCostCents: 300 });
    expect(res.status).toBe(200);
    const holdId = (res.body as { holdId: string }).holdId;
    expect(holdId).toBeTruthy();
    expect((await d.ledger.getHold(holdId))?.reservedCents).toBe(300);
  });

  it("402 when reserving more than the balance", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 100, NOW);
    const res = await call(d, KEY, "/holds", "POST", { userId: "u1", maxCostCents: 500 });
    expect(res.status).toBe(402);
  });

  it("settles a hold with the actual cost and releases overshoot", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 1000, NOW);
    const holdId = await d.ledger.reserveHold("u1", 300, NOW);
    const res = await call(d, KEY, "/holds/settle", "POST", {
      holdId,
      actualCostCents: 120,
      sourceRef: "auto-active-r1",
    });
    expect(res.status).toBe(200);
    // 1000 - 300 hold + 180 overshoot returned = 880 available.
    expect(res.body).toMatchObject({ availableBalanceCents: 880 });
    expect((await d.ledger.getHold(holdId))?.status).toBe("settled");
  });

  it("releases a hold back to the available balance", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 1000, NOW);
    const holdId = await d.ledger.reserveHold("u1", 300, NOW);
    const res = await call(d, KEY, "/holds/release", "POST", { holdId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ availableBalanceCents: 1000 });
    expect((await d.ledger.getHold(holdId))?.status).toBe("released");
  });

  it("settle 400 when holdId is missing", async () => {
    const res = await call(makeDeps(), KEY, "/holds/settle", "POST", { actualCostCents: 1 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// free-minutes: read + consume (idempotent per runId)
// ---------------------------------------------------------------------------

describe("free-minutes", () => {
  it("reads usage for a user + month", async () => {
    const d = makeDeps();
    await d.ledger.consumeFreeActiveMinutes("u1", "2026-06", 10, 60, "r1");
    const res = await call(d, KEY, "/free-minutes", "GET", undefined, "userId=u1&yearMonth=2026-06");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ usedMinutes: 10 });
  });

  it("400 when query params are missing", async () => {
    const res = await call(makeDeps(), KEY, "/free-minutes", "GET", undefined, "userId=u1");
    expect(res.status).toBe(400);
  });

  it("consume-free-minutes returns billable minutes outside the allowance", async () => {
    const d = makeDeps();
    const res = await call(d, KEY, "/consume-free-minutes", "POST", {
      userId: "u1",
      yearMonth: "2026-06",
      runActiveMinutes: 70,
      freeAllowance: 60,
      runId: "r1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ billableMinutes: 10 });
  });

  it("consume-free-minutes is idempotent per runId (replays first result)", async () => {
    const d = makeDeps();
    const body = {
      userId: "u1",
      yearMonth: "2026-06",
      runActiveMinutes: 70,
      freeAllowance: 60,
      runId: "r1",
    };
    const first = await call(d, KEY, "/consume-free-minutes", "POST", body);
    const second = await call(d, KEY, "/consume-free-minutes", "POST", body);
    expect((first.body as { billableMinutes: number }).billableMinutes).toBe(10);
    expect((second.body as { billableMinutes: number }).billableMinutes).toBe(10);
    // No double-deplete: usage stayed at 70, not 140.
    expect(await d.ledger.getFreeMinutesUsed("u1", "2026-06")).toBe(70);
  });

  it("400 on a negative runActiveMinutes", async () => {
    const res = await call(makeDeps(), KEY, "/consume-free-minutes", "POST", {
      userId: "u1",
      yearMonth: "2026-06",
      runActiveMinutes: -1,
      freeAllowance: 60,
      runId: "r1",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// seller-earnings: accrue / pending / transferred (premium royalties)
// ---------------------------------------------------------------------------

describe("accrue-royalty + seller-earnings", () => {
  it("accrues a royalty (net of commission) and lists it as pending", async () => {
    const d = makeDeps();
    const res = await call(d, KEY, "/accrue-royalty", "POST", {
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 500,
      commissionBps: 600, // 6% → net 470
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(await d.ledger.getPendingSellerEarnings()).toEqual([
      { orgId: "org-1", pendingCents: 470, transferredCents: 0 },
    ]);
  });

  it("is idempotent per runId (a re-accrue accrues once)", async () => {
    const d = makeDeps();
    const body = { orgId: "org-1", kitId: "kit-1", runId: "run-1", grossRoyaltyCents: 500, commissionBps: 0 };
    await call(d, KEY, "/accrue-royalty", "POST", body);
    await call(d, KEY, "/accrue-royalty", "POST", body);
    expect(await d.ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 500, transferredCents: 0 }]);
  });

  it("400 on a missing orgId / negative gross / negative commission", async () => {
    const d = makeDeps();
    expect((await call(d, KEY, "/accrue-royalty", "POST", { kitId: "k", runId: "r", grossRoyaltyCents: 1, commissionBps: 0 })).status).toBe(400);
    expect((await call(d, KEY, "/accrue-royalty", "POST", { orgId: "o", kitId: "k", runId: "r", grossRoyaltyCents: -1, commissionBps: 0 })).status).toBe(400);
    expect((await call(d, KEY, "/accrue-royalty", "POST", { orgId: "o", kitId: "k", runId: "r", grossRoyaltyCents: 1, commissionBps: -1 })).status).toBe(400);
  });

  it("GET pending returns the pending list", async () => {
    const d = makeDeps();
    await d.ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "r1", grossRoyaltyCents: 500, commissionBps: 0, now: NOW });
    const res = await call(d, KEY, "/seller-earnings/pending", "GET");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: [{ orgId: "org-1", pendingCents: 500, transferredCents: 0 }] });
  });

  it("POST transferred reduces the pending balance and is idempotent per transferRef", async () => {
    const d = makeDeps();
    await d.ledger.accrueRoyalty({ orgId: "org-1", kitId: "k", runId: "r1", grossRoyaltyCents: 500, commissionBps: 0, now: NOW });
    const body = { orgId: "org-1", amountCents: 200, transferRef: "xfer-1" };
    const first = await call(d, KEY, "/seller-earnings/transferred", "POST", body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true });
    await call(d, KEY, "/seller-earnings/transferred", "POST", body); // replay
    expect(await d.ledger.getPendingSellerEarnings()).toEqual([{ orgId: "org-1", pendingCents: 300, transferredCents: 200 }]);
  });

  it("transferred 400 on a missing orgId / transferRef / negative amount", async () => {
    const d = makeDeps();
    expect((await call(d, KEY, "/seller-earnings/transferred", "POST", { amountCents: 1, transferRef: "x" })).status).toBe(400);
    expect((await call(d, KEY, "/seller-earnings/transferred", "POST", { orgId: "o", amountCents: 1 })).status).toBe(400);
    expect((await call(d, KEY, "/seller-earnings/transferred", "POST", { orgId: "o", amountCents: -1, transferRef: "x" })).status).toBe(400);
  });

  it("all three still require the service key", async () => {
    const d = makeDeps();
    expect((await call(d, "wrong", "/accrue-royalty", "POST", {})).status).toBe(403);
    expect((await call(d, "wrong", "/seller-earnings/pending", "GET")).status).toBe(403);
    expect((await call(d, "wrong", "/seller-earnings/transferred", "POST", {})).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// auto-v2-rates (the moat — injected pricing vs zeros)
// ---------------------------------------------------------------------------

describe("auto-v2-rates", () => {
  it("returns the INJECTED pricing values", async () => {
    const d = makeDeps({
      autoV2Pricing: () => ({
        invocationFeeCents: 1,
        activeMinuteRateCents: 1,
        freeActiveMinutesPerMonth: 60,
      }),
    });
    const res = await call(d, KEY, "/auto-v2-rates", "GET");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invocationFeeCents: 1,
      activeMinuteRateCents: 1,
      freeActiveMinutesPerMonth: 60,
    });
  });

  it("returns all-zeros when no pricing provider is injected (public / self-host)", async () => {
    const res = await call(makeDeps(), KEY, "/auto-v2-rates", "GET");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invocationFeeCents: 0,
      activeMinuteRateCents: 0,
      freeActiveMinutesPerMonth: 0,
    });
  });

  it("still requires the service key", async () => {
    const res = await call(makeDeps(), "wrong", "/auto-v2-rates", "GET");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// can-start (READ-ONLY affordability pre-check)
// ---------------------------------------------------------------------------

describe("can-start", () => {
  const pricing = () => ({
    invocationFeeCents: 1,
    activeMinuteRateCents: 1,
    freeActiveMinutesPerMonth: 60,
  });

  it("allows a funded managed user (invocation + minute + floor covered)", async () => {
    const d = makeDeps({ autoV2Pricing: pricing, managedInferenceFloorCents: 5 });
    await d.ledger.topup("u1", 700, NOW);
    // Exhaust the free allowance so the estimate includes the minute fee.
    await d.ledger.consumeFreeActiveMinutes("u1", FREE_TRIAL_PERIOD_KEY, 60, 60, "run-past");
    const res = await call(d, KEY, "/can-start", "POST", { userId: "u1", mode: "managed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
  });

  it("allows a ZERO-balance user with free minutes remaining (free tier counts)", async () => {
    const d = makeDeps({ autoV2Pricing: pricing, managedInferenceFloorCents: 5 });
    const res = await call(d, KEY, "/can-start", "POST", { userId: "u-new", mode: "managed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
  });

  it("denies a broke managed user with 200 {allowed:false, reason:insufficient_funds}", async () => {
    const d = makeDeps({ autoV2Pricing: pricing, managedInferenceFloorCents: 5 });
    await d.ledger.topup("u1", 6, NOW); // needs 7 (1 + 1 + 5)
    await d.ledger.consumeFreeActiveMinutes("u1", FREE_TRIAL_PERIOD_KEY, 60, 60, "run-past");
    const res = await call(d, KEY, "/can-start", "POST", { userId: "u1", mode: "managed" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: false, reason: "insufficient_funds" });
  });

  it("byo preflights only OUR fees (no inference floor)", async () => {
    const d = makeDeps({ autoV2Pricing: pricing, managedInferenceFloorCents: 5 });
    await d.ledger.topup("u1", 2, NOW); // exactly invocation + minute
    await d.ledger.consumeFreeActiveMinutes("u1", FREE_TRIAL_PERIOD_KEY, 60, 60, "run-past");
    const byo = await call(d, KEY, "/can-start", "POST", { userId: "u1", mode: "byo" });
    expect(byo.body).toEqual({ allowed: true });
    const managed = await call(d, KEY, "/can-start", "POST", { userId: "u1", mode: "managed" });
    expect(managed.body).toMatchObject({ allowed: false, reason: "insufficient_funds" });
  });

  it("always allows when no pricing provider is injected (public / self-host)", async () => {
    const d = makeDeps({ managedInferenceFloorCents: 5 });
    const res = await call(d, KEY, "/can-start", "POST", { userId: "broke", mode: "managed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true });
  });

  it("NEVER mutates the ledger (no account/hold/txn created by a check)", async () => {
    const d = makeDeps({ autoV2Pricing: pricing, managedInferenceFloorCents: 5 });
    await call(d, KEY, "/can-start", "POST", { userId: "ghost", mode: "managed" });
    expect(d.ledger.accounts.size).toBe(0);
    expect(d.ledger.holds.size).toBe(0);
    expect(d.ledger.txns.length).toBe(0);
  });

  it("400 on a missing userId or a bad mode", async () => {
    const d = makeDeps({ autoV2Pricing: pricing });
    expect((await call(d, KEY, "/can-start", "POST", { mode: "managed" })).status).toBe(400);
    expect((await call(d, KEY, "/can-start", "POST", { userId: "u1", mode: "weird" })).status).toBe(400);
    expect((await call(d, KEY, "/can-start", "POST", "nope")).status).toBe(400);
  });

  it("still requires the service key", async () => {
    const d = makeDeps({ autoV2Pricing: pricing });
    expect((await call(d, "wrong", "/can-start", "POST", { userId: "u1", mode: "byo" })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// unknown route
// ---------------------------------------------------------------------------

describe("unknown ledger route", () => {
  it("404 for an unmatched sub-path", async () => {
    const res = await call(makeDeps(), KEY, "/nope", "POST", {});
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// pre-route wiring (path match + query parse from req.url)
// ---------------------------------------------------------------------------

describe("makeLedgerPreRoute", () => {
  const fakeReq = (url: string, headers: Record<string, string> = {}) =>
    ({ url, headers } as unknown as Parameters<ReturnType<typeof makeLedgerPreRoute>>[0]);

  it("intercepts /gateway/ledger/* and parses the query from req.url", async () => {
    const d = makeDeps();
    await d.ledger.topup("u1", 700, NOW);
    const preRoute = makeLedgerPreRoute(d);
    const handled = await preRoute(
      fakeReq(`${LEDGER_ROUTE_PREFIX}/account?userId=u1`, { "x-gateway-service-key": KEY }),
      { path: `${LEDGER_ROUTE_PREFIX}/account`, method: "GET", body: undefined },
    );
    expect(handled?.status).toBe(200);
    expect(handled?.body).toMatchObject({ userId: "u1", availableBalanceCents: 700 });
  });

  it("falls through (undefined) for non-ledger paths", async () => {
    const preRoute = makeLedgerPreRoute(makeDeps());
    const handled = await preRoute(fakeReq("/gateway/credits/topup", { "x-gateway-service-key": KEY }), {
      path: "/gateway/credits/topup",
      method: "POST",
      body: {},
    });
    expect(handled).toBeUndefined();
  });

  it("does not match a path that merely shares the prefix string", async () => {
    const preRoute = makeLedgerPreRoute(makeDeps());
    const handled = await preRoute(fakeReq("/gateway/ledgerX", { "x-gateway-service-key": KEY }), {
      path: "/gateway/ledgerX",
      method: "GET",
      body: undefined,
    });
    expect(handled).toBeUndefined();
  });
});
