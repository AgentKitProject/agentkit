/**
 * Worker credit-ledger selection over HTTP (gateway-service refactor).
 *
 * Auto used to debit the credit ledger by importing the private
 * `@agentkit-commercial/gateway` package and opening its OWN pool against the
 * gateway's Postgres DB. It now reaches the ledger ONLY over HTTP through the
 * gateway's service-key-gated `/gateway/ledger/*` endpoints, so the open-core
 * Auto images carry no commercial dependency.
 *
 *   - GATEWAY_INTERNAL_BASE_URL + GATEWAY_SERVICE_KEY set → the HTTP-backed
 *     ledger (managed) + rates fetched from the gateway.
 *   - either absent (public / self-host) → the inert FREE ledger (never debits)
 *     and 0/0/0 rates.
 *
 * No real gateway, no real inference: an in-memory fake gateway behind an
 * injected fetch backs the HTTP client; the managed-turn assertion uses a mocked
 * ChatProvider.
 */

import { describe, expect, it } from "vitest";
import {
  runManagedTurn,
  InMemoryCreditLedgerRepository,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
} from "@agentkitforge/gateway-core";
import { loadManagedLedgerWithFlag, loadAutoV2Rates } from "../src/entrypoints/run-task.js";
import { HttpLedgerClient } from "../src/adapters/http/http-ledger-client.js";

const NOW = "2026-06-25T00:00:00.000Z";
const BASE = "http://gw.internal";
const KEY = "svc-key";

/** A mocked ChatProvider — no real Anthropic call. */
class FakeProvider implements ChatProvider {
  readonly providerType = "fake";
  calls = 0;
  async sendMessage(_request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    return {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedWriteTokens: 0 },
    };
  }
  async streamMessage(): Promise<ChatResponse> {
    throw new Error("not used");
  }
}

/**
 * Builds a fake `fetch` that routes `/gateway/ledger/*` requests to an in-memory
 * credit ledger (the gateway's ledger, server-side). Mirrors the real gateway
 * ledger-routes handler shape (server-stamps `now`, idempotent sourceRef).
 */
function makeFakeGatewayFetch(opts?: {
  ledger?: InMemoryCreditLedgerRepository;
  rates?: { invocationFeeCents: number; activeMinuteRateCents: number; freeActiveMinutesPerMonth: number };
  failRates?: boolean;
}): { fetchImpl: typeof fetch; ledger: InMemoryCreditLedgerRepository } {
  const ledger = opts?.ledger ?? new InMemoryCreditLedgerRepository();
  const j = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname.replace("/gateway/ledger", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

    if (path === "/auto-v2-rates" && method === "GET") {
      if (opts?.failRates) return j(500, { error: "boom" });
      return j(
        200,
        opts?.rates ?? { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 },
      );
    }
    if (path === "/ensure-account" && method === "POST") {
      return j(200, await ledger.ensureAccount(body.userId as string, NOW));
    }
    if (path === "/account" && method === "GET") {
      const acc = await ledger.getAccount(url.searchParams.get("userId")!);
      return acc ? j(200, acc) : j(404, { error: "account_not_found" });
    }
    if (path === "/debit" && method === "POST") {
      try {
        const acc = await ledger.debit(
          body.userId as string,
          body.amountCents as number,
          NOW,
          body.description as string | undefined,
          body.sourceRef as string | undefined,
        );
        return j(200, acc);
      } catch {
        return j(402, { error: "insufficient_balance" });
      }
    }
    if (path === "/holds" && method === "POST") {
      try {
        const holdId = await ledger.reserveHold(body.userId as string, body.maxCostCents as number, NOW);
        return j(200, { holdId });
      } catch {
        return j(402, { error: "insufficient_balance" });
      }
    }
    if (path === "/holds/settle" && method === "POST") {
      const acc = await ledger.settleHold(
        body.holdId as string,
        body.actualCostCents as number,
        NOW,
        body.sourceRef as string | undefined,
      );
      return j(200, acc);
    }
    if (path === "/holds/release" && method === "POST") {
      const acc = await ledger.releaseHold(body.holdId as string, NOW);
      return j(200, acc);
    }
    if (path === "/free-minutes" && method === "GET") {
      const used = await ledger.getFreeMinutesUsed(
        url.searchParams.get("userId")!,
        url.searchParams.get("yearMonth")!,
      );
      return j(200, { usedMinutes: used });
    }
    if (path === "/consume-free-minutes" && method === "POST") {
      const billable = await ledger.consumeFreeActiveMinutes(
        body.userId as string,
        body.yearMonth as string,
        body.runActiveMinutes as number,
        body.freeAllowance as number,
        body.runId as string,
      );
      return j(200, { billableMinutes: billable });
    }
    return j(404, { error: "ledger_route_not_found" });
  };
  return { fetchImpl, ledger };
}

describe("loadManagedLedgerWithFlag (HTTP)", () => {
  it("GATEWAY base URL + service key set → HttpLedgerClient (managed=true)", () => {
    const { ledger, managed } = loadManagedLedgerWithFlag({
      GATEWAY_INTERNAL_BASE_URL: BASE,
      GATEWAY_SERVICE_KEY: KEY,
    });
    expect(managed).toBe(true);
    expect(ledger).toBeInstanceOf(HttpLedgerClient);
  });

  it("missing base URL → inert FREE ledger (managed=false, spend throws)", async () => {
    const { ledger, managed } = loadManagedLedgerWithFlag({ GATEWAY_SERVICE_KEY: KEY });
    expect(managed).toBe(false);
    await expect(ledger.reserveHold("u1", 100, NOW)).rejects.toThrow();
  });

  it("missing service key → inert FREE ledger (managed=false)", () => {
    const { managed } = loadManagedLedgerWithFlag({ GATEWAY_INTERNAL_BASE_URL: BASE });
    expect(managed).toBe(false);
  });
});

describe("HttpLedgerClient backs a managed turn", () => {
  it("a managed turn reserves + settles against the HTTP-backed ledger (no throw)", async () => {
    const { fetchImpl, ledger: serverLedger } = makeFakeGatewayFetch();
    await serverLedger.topup("u1", 1_000_000, NOW); // fund the account server-side
    const client = new HttpLedgerClient({ baseUrl: BASE, serviceKey: KEY, fetchImpl });

    const provider = new FakeProvider();
    const result = await runManagedTurn(
      { chatProvider: provider, ledger: client, now: () => NOW, markupBps: 2500 },
      {
        userId: "u1",
        request: {
          model: "claude-sonnet-4-6",
          system: "s",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
          maxTokens: 256,
        },
      },
    );

    expect(provider.calls).toBe(1);
    expect(result.debitedCents).toBeGreaterThan(0);
    // The balance went down by exactly the debited amount (hold reserved, settled).
    const acc = await serverLedger.getAccount("u1");
    expect(acc?.availableBalanceCents).toBe(1_000_000 - result.debitedCents);
    expect(acc?.heldBalanceCents).toBe(0); // hold fully settled
  });
});

describe("loadAutoV2Rates (HTTP)", () => {
  it("returns 0/0/0 when not enabled, without fetching", async () => {
    let fetched = false;
    const fetchImpl: typeof fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    const rates = await loadAutoV2Rates(
      false,
      { GATEWAY_INTERNAL_BASE_URL: BASE, GATEWAY_SERVICE_KEY: KEY },
      fetchImpl,
    );
    expect(rates).toEqual({ invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 });
    expect(fetched).toBe(false);
  });

  it("fetches the gateway rates when enabled (hosted managed)", async () => {
    const { fetchImpl } = makeFakeGatewayFetch({
      rates: { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 },
    });
    const rates = await loadAutoV2Rates(
      true,
      { GATEWAY_INTERNAL_BASE_URL: BASE, GATEWAY_SERVICE_KEY: KEY },
      fetchImpl,
    );
    expect(rates).toEqual({ invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 });
  });

  it("returns 0/0/0 when enabled but the gateway config is absent (never charge)", async () => {
    const rates = await loadAutoV2Rates(true, {});
    expect(rates).toEqual({ invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 });
  });

  it("returns 0/0/0 when the rates fetch fails (never charge on error)", async () => {
    const { fetchImpl } = makeFakeGatewayFetch({ failRates: true });
    const rates = await loadAutoV2Rates(
      true,
      { GATEWAY_INTERNAL_BASE_URL: BASE, GATEWAY_SERVICE_KEY: KEY },
      fetchImpl,
    );
    expect(rates).toEqual({ invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 });
  });

  it("env overrides take precedence over the fetched rates (still gated on enabled)", async () => {
    const { fetchImpl } = makeFakeGatewayFetch({
      rates: { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 },
    });
    const rates = await loadAutoV2Rates(
      true,
      {
        GATEWAY_INTERNAL_BASE_URL: BASE,
        GATEWAY_SERVICE_KEY: KEY,
        AUTO_INVOCATION_FEE_CENTS: "3",
        AUTO_ACTIVE_MINUTE_RATE_CENTS: "7",
        AUTO_FREE_ACTIVE_MINUTES_PER_MONTH: "120",
      },
      fetchImpl,
    );
    expect(rates).toEqual({ invocationFeeCents: 3, activeMinuteRateCents: 7, freeActiveMinutesPerMonth: 120 });
  });

  it("env overrides do NOT bypass the disabled gate (free stays free)", async () => {
    const rates = await loadAutoV2Rates(false, {
      AUTO_INVOCATION_FEE_CENTS: "3",
      AUTO_ACTIVE_MINUTE_RATE_CENTS: "7",
      AUTO_FREE_ACTIVE_MINUTES_PER_MONTH: "120",
    });
    expect(rates).toEqual({ invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 });
  });
});
