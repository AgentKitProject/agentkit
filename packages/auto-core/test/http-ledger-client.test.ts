/**
 * HttpLedgerClient — maps each CreditLedgerRepository method Auto calls to the
 * right gateway `/gateway/ledger/*` request, and the response back to the port
 * shape. Uses a recording fake fetch (no real gateway).
 *
 * Asserts: correct path/method/body per call; the service-key header on every
 * request; `now` is NEVER sent (the gateway stamps it server-side); 404 on
 * getAccount → undefined; non-2xx → throws (status only, no body leak); the
 * methods Auto never calls throw "not supported over HTTP".
 */

import { describe, expect, it } from "vitest";
import { HttpLedgerClient } from "../src/adapters/http/http-ledger-client.js";

const BASE = "http://gw.internal";
const KEY = "svc-key";
const NOW = "2026-06-25T00:00:00.000Z";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(responder: (rec: Recorded) => { status: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const rec: Recorded = { url, method: (init?.method ?? "GET").toUpperCase(), headers, body };
    calls.push(rec);
    const { status, body: respBody } = responder(rec);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

const account = {
  userId: "u1",
  availableBalanceCents: 999,
  heldBalanceCents: 0,
  lifetimeTopupCents: 0,
  updatedAt: NOW,
};

function client(fetchImpl: typeof fetch): HttpLedgerClient {
  return new HttpLedgerClient({ baseUrl: BASE, serviceKey: KEY, fetchImpl });
}

describe("HttpLedgerClient request mapping", () => {
  it("ensureAccount → POST /ensure-account {userId}, no now in body", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: account }));
    const res = await client(fetchImpl).ensureAccount("u1", NOW);
    expect(res).toEqual(account);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/ensure-account`);
    expect(calls[0]!.body).toEqual({ userId: "u1" });
    expect(calls[0]!.body).not.toHaveProperty("now");
    expect(calls[0]!.headers["x-gateway-service-key"]).toBe(KEY);
  });

  it("getAccount → GET /account?userId=, returns the account", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: account }));
    const res = await client(fetchImpl).getAccount("u1");
    expect(res).toEqual(account);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/account?userId=u1`);
    expect(calls[0]!.headers["x-gateway-service-key"]).toBe(KEY);
  });

  it("getAccount → 404 maps to undefined", async () => {
    const { fetchImpl } = recorder(() => ({ status: 404, body: { error: "account_not_found" } }));
    expect(await client(fetchImpl).getAccount("ghost")).toBeUndefined();
  });

  it("debit → POST /debit {userId, amountCents, description, sourceRef}, no now", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: account }));
    await client(fetchImpl).debit("u1", 1, NOW, "invocation", "auto-invocation-r1");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/debit`);
    expect(calls[0]!.body).toEqual({
      userId: "u1",
      amountCents: 1,
      description: "invocation",
      sourceRef: "auto-invocation-r1",
    });
    expect(calls[0]!.body).not.toHaveProperty("now");
  });

  it("reserveHold → POST /holds {userId, maxCostCents}, returns holdId", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: { holdId: "h-1" } }));
    const holdId = await client(fetchImpl).reserveHold("u1", 300, NOW);
    expect(holdId).toBe("h-1");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/holds`);
    expect(calls[0]!.body).toEqual({ userId: "u1", maxCostCents: 300 });
  });

  it("settleHold → POST /holds/settle {holdId, actualCostCents, sourceRef}", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: account }));
    await client(fetchImpl).settleHold("h-1", 120, NOW, "auto-active-r1");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/holds/settle`);
    expect(calls[0]!.body).toEqual({ holdId: "h-1", actualCostCents: 120, sourceRef: "auto-active-r1" });
    expect(calls[0]!.body).not.toHaveProperty("now");
  });

  it("releaseHold → POST /holds/release {holdId}", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: account }));
    await client(fetchImpl).releaseHold("h-1", NOW);
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/holds/release`);
    expect(calls[0]!.body).toEqual({ holdId: "h-1" });
  });

  it("getFreeMinutesUsed → GET /free-minutes?userId=&yearMonth=, returns usedMinutes", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: { usedMinutes: 12 } }));
    const used = await client(fetchImpl).getFreeMinutesUsed("u1", "2026-06");
    expect(used).toBe(12);
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/free-minutes?userId=u1&yearMonth=2026-06`);
  });

  it("consumeFreeActiveMinutes → POST /consume-free-minutes, returns billableMinutes", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: { billableMinutes: 10 } }));
    const billable = await client(fetchImpl).consumeFreeActiveMinutes("u1", "2026-06", 70, 60, "r1");
    expect(billable).toBe(10);
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/consume-free-minutes`);
    expect(calls[0]!.body).toEqual({
      userId: "u1",
      yearMonth: "2026-06",
      runActiveMinutes: 70,
      freeAllowance: 60,
      runId: "r1",
    });
  });

  it("a non-2xx response throws with the status only (no body leak)", async () => {
    const { fetchImpl } = recorder(() => ({ status: 402, body: { error: "insufficient_balance", secret: "x" } }));
    await expect(client(fetchImpl).debit("u1", 100, NOW)).rejects.toThrow(/HTTP 402/);
    await expect(client(fetchImpl).debit("u1", 100, NOW)).rejects.not.toThrow(/secret/);
  });

  it("strips a trailing slash from the base URL", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: account }));
    const c = new HttpLedgerClient({ baseUrl: `${BASE}/`, serviceKey: KEY, fetchImpl });
    await c.ensureAccount("u1", NOW);
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/ensure-account`);
  });
});

describe("HttpLedgerClient seller-earnings (premium royalties)", () => {
  it("accrueRoyalty → POST /accrue-royalty, no now in body", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: { ok: true } }));
    await client(fetchImpl).accrueRoyalty({
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 500,
      commissionBps: 600,
      now: NOW,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/accrue-royalty`);
    expect(calls[0]!.body).toEqual({
      orgId: "org-1",
      kitId: "kit-1",
      runId: "run-1",
      grossRoyaltyCents: 500,
      commissionBps: 600,
    });
    expect(calls[0]!.body).not.toHaveProperty("now");
    expect(calls[0]!.headers["x-gateway-service-key"]).toBe(KEY);
  });

  it("getPendingSellerEarnings → GET /seller-earnings/pending, returns the list", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: { pending: [{ orgId: "org-1", pendingCents: 470 }] },
    }));
    const pending = await client(fetchImpl).getPendingSellerEarnings();
    expect(pending).toEqual([{ orgId: "org-1", pendingCents: 470 }]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/seller-earnings/pending`);
  });

  it("getPendingSellerEarnings → 404 maps to []", async () => {
    const { fetchImpl } = recorder(() => ({ status: 404, body: {} }));
    expect(await client(fetchImpl).getPendingSellerEarnings()).toEqual([]);
  });

  it("markSellerEarningsTransferred → POST /seller-earnings/transferred, no now", async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: { ok: true } }));
    await client(fetchImpl).markSellerEarningsTransferred("org-1", 200, "xfer-1", NOW);
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/seller-earnings/transferred`);
    expect(calls[0]!.body).toEqual({ orgId: "org-1", amountCents: 200, transferRef: "xfer-1" });
    expect(calls[0]!.body).not.toHaveProperty("now");
  });
});

describe("HttpLedgerClient fetchAutoV2Rates", () => {
  it("returns the gateway rates on success", async () => {
    const { fetchImpl } = recorder(() => ({
      status: 200,
      body: { invocationFeeCents: 1, activeMinuteRateCents: 2, freeActiveMinutesPerMonth: 60 },
    }));
    expect(await client(fetchImpl).fetchAutoV2Rates()).toEqual({
      invocationFeeCents: 1,
      activeMinuteRateCents: 2,
      freeActiveMinutesPerMonth: 60,
    });
  });

  it("returns 0/0/0 on a failing fetch (never charge on error)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect(await client(fetchImpl).fetchAutoV2Rates()).toEqual({
      invocationFeeCents: 0,
      activeMinuteRateCents: 0,
      freeActiveMinutesPerMonth: 0,
    });
  });

  it("returns 0/0/0 on a 404 (no pricing injected)", async () => {
    const { fetchImpl } = recorder(() => ({ status: 404, body: {} }));
    expect(await client(fetchImpl).fetchAutoV2Rates()).toEqual({
      invocationFeeCents: 0,
      activeMinuteRateCents: 0,
      freeActiveMinutesPerMonth: 0,
    });
  });
});

describe("HttpLedgerClient canStartRun", () => {
  it("POSTs /can-start {userId, mode} with the service key and returns the verdict", async () => {
    const { calls, fetchImpl } = recorder(() => ({
      status: 200,
      body: { allowed: false, reason: "insufficient_funds", detail: "needs 7c" },
    }));
    const verdict = await client(fetchImpl).canStartRun({ userId: "u1", mode: "managed" });
    expect(verdict).toEqual({ allowed: false, reason: "insufficient_funds", detail: "needs 7c" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/gateway/ledger/can-start`);
    expect(calls[0]!.body).toEqual({ userId: "u1", mode: "managed" });
    expect(calls[0]!.headers["x-gateway-service-key"]).toBe(KEY);
  });

  it("passes an allowed verdict through without extra fields", async () => {
    const { fetchImpl } = recorder(() => ({ status: 200, body: { allowed: true } }));
    expect(await client(fetchImpl).canStartRun({ userId: "u1", mode: "byo" })).toEqual({
      allowed: true,
    });
  });

  it("throws on non-2xx with the status only (caller maps to ledger_unavailable)", async () => {
    const { fetchImpl } = recorder(() => ({ status: 503, body: { error: "secret detail" } }));
    await expect(client(fetchImpl).canStartRun({ userId: "u1", mode: "managed" })).rejects.toThrow(
      /HTTP 503/,
    );
    await expect(
      client(fetchImpl).canStartRun({ userId: "u1", mode: "managed" }),
    ).rejects.not.toThrow(/secret detail/);
  });
});

describe("HttpLedgerClient unsupported methods", () => {
  it("topup / recordTransaction / getHold / listTransactions throw", async () => {
    const { fetchImpl } = recorder(() => ({ status: 200, body: {} }));
    const c = client(fetchImpl);
    await expect(c.topup("u1", 1, NOW)).rejects.toThrow(/not supported over HTTP/);
    await expect(
      c.recordTransaction({ userId: "u1", type: "debit", amountCents: 1, createdAt: NOW }),
    ).rejects.toThrow(/not supported over HTTP/);
    await expect(c.getHold("h-1")).rejects.toThrow(/not supported over HTTP/);
    await expect(c.listTransactions("u1")).rejects.toThrow(/not supported over HTTP/);
  });
});
