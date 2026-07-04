/**
 * Internal, service-key-gated CREDIT-LEDGER endpoints for the managed gateway.
 *
 * BOUNDARY: AgentKitAuto (the worker + the web pre-flight balance check) is the
 * only caller. Auto used to debit the credit ledger by importing the COMMERCIAL
 * package and opening its OWN pool against the gateway's Postgres database. That
 * coupled the open-core Auto images to `@agentkit-commercial/gateway` and to the
 * gateway DB credentials. These endpoints move that seam over HTTP: Auto now
 * reaches the ledger ONLY through `POST/GET /gateway/ledger/*`, so the gateway
 * stays the sole holder of its DB credentials and the only place the moat lives.
 *
 * This module is GENERIC (no Stripe, no commercial code, no moat NUMBERS): it
 * takes an INJECTED `CreditLedgerRepository` (the same instance the gateway wires
 * for topup + inference) and an INJECTED expected service key. It mirrors
 * `credit-topup.ts` exactly: path → method → service-key (constant-time) →
 * parse → ledger call → JSON response.
 *
 * AUTH: the shared `GATEWAY_SERVICE_KEY` (constant-time compared), NOT WorkOS.
 * Same server-to-server trust seam as the credit-topup endpoint. Undefined/empty
 * key → every call is 503 (inert): a misconfigured deploy can never serve the
 * ledger unauthenticated.
 *
 * NOW IS SERVER-STAMPED: every ledger method takes `now: string`. Over HTTP the
 * GATEWAY stamps `now` server-side — the request bodies NEVER carry a client
 * clock. This keeps transaction timestamps authoritative.
 *
 * IDEMPOTENCY: the handlers pass `sourceRef`/`runId` straight through to the
 * ledger, whose DB-enforced uniqueness makes a retried debit/settle/free-minute
 * application a no-op — identical to the in-process semantics they replace.
 */

import type { CreditLedgerRepository } from "../core/ports.js";
import type { CreditAccount } from "../core/types.js";
import type { GatewayJsonResponse } from "../core/router.js";
import { constantTimeEqual } from "./credit-topup.js";
import {
  checkAffordability,
  type RunBillingMode,
} from "../core/services/affordability.js";

/** Base path prefix for the ledger endpoints. */
export const LEDGER_ROUTE_PREFIX = "/gateway/ledger";

/** The resolved Auto v2 run-pricing the gateway serves to Auto over HTTP.
 *  The VALUES are the commercial moat; this is only the SHAPE (no numbers). */
export interface AutoV2PricingShape {
  /** Flat per-run invocation fee in US cents. */
  invocationFeeCents: number;
  /** Per-active-minute rate in US cents. */
  activeMinuteRateCents: number;
  /** Per-user, per-calendar-month free active-minute allowance. */
  freeActiveMinutesPerMonth: number;
}

/** Dependencies for the ledger-route handlers. */
export interface LedgerRoutesDeps {
  ledger: CreditLedgerRepository;
  /**
   * The expected `GATEWAY_SERVICE_KEY`. Undefined/empty → INERT (503 on every
   * call) so a misconfigured deploy can never accept unauthenticated ledger ops.
   */
  serviceKey: string | undefined;
  /** Clock. Defaults to `() => new Date().toISOString()`. Server-stamped. */
  now?: () => string;
  /**
   * OPTIONAL Auto v2 pricing provider. Injected by the COMMERCIAL hosted
   * composition (the moat NUMBERS). When NOT injected (public / self-host
   * gateway) the rates endpoint returns all-zeros so a self-host pays nothing.
   */
  autoV2Pricing?: () => AutoV2PricingShape;
  /**
   * OPTIONAL managed inference floor (US cents) for the `POST /can-start`
   * affordability pre-check. Defaults to MANAGED_INFERENCE_FLOOR_CENTS inside
   * `checkAffordability`; the server wires it from
   * GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS (operator-tunable, mechanism-neutral
   * public default — not a commercial value).
   */
  managedInferenceFloorCents?: number;
}

function json(status: number, body: unknown): GatewayJsonResponse {
  return { kind: "json", status, body };
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function requireInt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function accountJson(account: CreditAccount): unknown {
  return {
    userId: account.userId,
    availableBalanceCents: account.availableBalanceCents,
    heldBalanceCents: account.heldBalanceCents,
    lifetimeTopupCents: account.lifetimeTopupCents,
    updatedAt: account.updatedAt,
  };
}

/**
 * Recognises an insufficient-balance error from the ledger so the HTTP layer can
 * map it to 402 (Payment Required) rather than a generic 500. The ledger throws
 * a plain Error on insufficient funds; match on its message defensively.
 */
function isInsufficientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return msg.includes("insufficient");
}

/** Reads the configured Auto v2 pricing, or all-zeros when not injected. */
function resolvePricing(deps: LedgerRoutesDeps): AutoV2PricingShape {
  if (!deps.autoV2Pricing) {
    return { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
  }
  const p = deps.autoV2Pricing();
  return {
    invocationFeeCents: Math.max(0, p.invocationFeeCents),
    activeMinuteRateCents: Math.max(0, p.activeMinuteRateCents),
    freeActiveMinutesPerMonth: Math.max(0, p.freeActiveMinutesPerMonth),
  };
}

/**
 * Dispatches a ledger request. `path` is the full request path (query stripped),
 * `query` is the parsed querystring (for the GET routes), `method` the HTTP verb,
 * `body` the parsed JSON body (POST). Returns a JSON gateway response.
 *
 * Auth precedes every branch:
 *   - 503 when no serviceKey is configured (inert)
 *   - 401 when no key is provided
 *   - 403 when the key is wrong
 * Then per-route: 400 (bad body), 404 (missing account/hold/route), 402
 * (insufficient balance), 500 (unexpected ledger error).
 */
export async function handleLedgerRequest(
  deps: LedgerRoutesDeps,
  providedKey: string | null | undefined,
  ctx: { path: string; method: string; body: unknown; query: URLSearchParams },
): Promise<GatewayJsonResponse> {
  const { serviceKey } = deps;
  if (!serviceKey || serviceKey.trim() === "") {
    return json(503, { error: "ledger_not_configured" });
  }
  if (providedKey === null || providedKey === undefined || providedKey === "") {
    return json(401, { error: "missing_service_key" });
  }
  if (!constantTimeEqual(providedKey, serviceKey)) {
    return json(403, { error: "invalid_service_key" });
  }

  const sub = ctx.path.slice(LEDGER_ROUTE_PREFIX.length); // e.g. "/debit"
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const { ledger } = deps;

  try {
    // ---- Rates (read; pricing provider is the moat) -----------------------
    if (sub === "/auto-v2-rates" && ctx.method === "GET") {
      return json(200, resolvePricing(deps));
    }

    // ---- canStart (READ-ONLY affordability pre-check) ----------------------
    // Body mirrors contracts' canStartRunRequestSchema ({userId, mode});
    // response mirrors canStartRunResponseSchema ({allowed, reason?, detail?}).
    // Never mutates the ledger. A ledger read failure falls to the generic 500
    // below — the CLIENT maps transport/HTTP errors to `ledger_unavailable`
    // (fail-closed for managed per CAN_START_FAIL_CLOSED_MODES, open for BYO).
    if (sub === "/can-start" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const userId = requireString(obj, "userId");
      const mode = requireString(obj, "mode");
      if (!userId) return json(400, { error: "userId is required." });
      if (mode !== "managed" && mode !== "byo") {
        return json(400, { error: 'mode must be "managed" or "byo".' });
      }
      const verdict = await checkAffordability(
        {
          ledger,
          pricing: resolvePricing(deps),
          ...(deps.managedInferenceFloorCents !== undefined
            ? { managedInferenceFloorCents: deps.managedInferenceFloorCents }
            : {}),
        },
        { userId, mode: mode as RunBillingMode, now },
      );
      return json(200, verdict);
    }

    // ---- ensureAccount ----------------------------------------------------
    if (sub === "/ensure-account" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      const userId = obj && requireString(obj, "userId");
      if (!userId) return json(400, { error: "userId is required." });
      const account = await ledger.ensureAccount(userId, now);
      return json(200, accountJson(account));
    }

    // ---- getAccount -------------------------------------------------------
    if (sub === "/account" && ctx.method === "GET") {
      const userId = ctx.query.get("userId");
      if (!userId || userId.trim() === "") return json(400, { error: "userId is required." });
      const account = await ledger.getAccount(userId);
      if (!account) return json(404, { error: "account_not_found" });
      return json(200, accountJson(account));
    }

    // ---- debit ------------------------------------------------------------
    if (sub === "/debit" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const userId = requireString(obj, "userId");
      const amountCents = requireInt(obj, "amountCents");
      if (!userId) return json(400, { error: "userId is required." });
      if (amountCents === undefined || amountCents < 0) {
        return json(400, { error: "amountCents must be a non-negative integer." });
      }
      const description = typeof obj["description"] === "string" ? (obj["description"] as string) : undefined;
      const sourceRef = typeof obj["sourceRef"] === "string" ? (obj["sourceRef"] as string) : undefined;
      const account = await ledger.debit(userId, amountCents, now, description, sourceRef);
      return json(200, accountJson(account));
    }

    // ---- reserveHold ------------------------------------------------------
    if (sub === "/holds" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const userId = requireString(obj, "userId");
      const maxCostCents = requireInt(obj, "maxCostCents");
      if (!userId) return json(400, { error: "userId is required." });
      if (maxCostCents === undefined || maxCostCents < 0) {
        return json(400, { error: "maxCostCents must be a non-negative integer." });
      }
      const holdId = await ledger.reserveHold(userId, maxCostCents, now);
      return json(200, { holdId });
    }

    // ---- settleHold -------------------------------------------------------
    if (sub === "/holds/settle" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const holdId = requireString(obj, "holdId");
      const actualCostCents = requireInt(obj, "actualCostCents");
      if (!holdId) return json(400, { error: "holdId is required." });
      if (actualCostCents === undefined || actualCostCents < 0) {
        return json(400, { error: "actualCostCents must be a non-negative integer." });
      }
      const sourceRef = typeof obj["sourceRef"] === "string" ? (obj["sourceRef"] as string) : undefined;
      const account = await ledger.settleHold(holdId, actualCostCents, now, sourceRef);
      return json(200, accountJson(account));
    }

    // ---- releaseHold ------------------------------------------------------
    if (sub === "/holds/release" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      const holdId = obj && requireString(obj, "holdId");
      if (!holdId) return json(400, { error: "holdId is required." });
      const account = await ledger.releaseHold(holdId, now);
      return json(200, accountJson(account));
    }

    // ---- getFreeMinutesUsed ----------------------------------------------
    if (sub === "/free-minutes" && ctx.method === "GET") {
      const userId = ctx.query.get("userId");
      const yearMonth = ctx.query.get("yearMonth");
      if (!userId || userId.trim() === "") return json(400, { error: "userId is required." });
      if (!yearMonth || yearMonth.trim() === "") return json(400, { error: "yearMonth is required." });
      const usedMinutes = await ledger.getFreeMinutesUsed(userId, yearMonth);
      return json(200, { usedMinutes });
    }

    // ---- consumeFreeActiveMinutes ----------------------------------------
    if (sub === "/consume-free-minutes" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const userId = requireString(obj, "userId");
      const yearMonth = requireString(obj, "yearMonth");
      const runActiveMinutes = requireInt(obj, "runActiveMinutes");
      const freeAllowance = requireInt(obj, "freeAllowance");
      const runId = requireString(obj, "runId");
      if (!userId) return json(400, { error: "userId is required." });
      if (!yearMonth) return json(400, { error: "yearMonth is required." });
      if (runActiveMinutes === undefined || runActiveMinutes < 0) {
        return json(400, { error: "runActiveMinutes must be a non-negative integer." });
      }
      if (freeAllowance === undefined || freeAllowance < 0) {
        return json(400, { error: "freeAllowance must be a non-negative integer." });
      }
      if (!runId) return json(400, { error: "runId is required." });
      const billableMinutes = await ledger.consumeFreeActiveMinutes(
        userId,
        yearMonth,
        runActiveMinutes,
        freeAllowance,
        runId,
      );
      return json(200, { billableMinutes });
    }

    // ---- accrueRoyalty (premium / per-invocation seller earnings) ---------
    // Idempotent per runId (source_ref = `royalty-${runId}`). netCents is
    // derived server-side; the request carries the GROSS royalty + commission.
    if (sub === "/accrue-royalty" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const orgId = requireString(obj, "orgId");
      const kitId = requireString(obj, "kitId");
      const runId = requireString(obj, "runId");
      const grossRoyaltyCents = requireInt(obj, "grossRoyaltyCents");
      const commissionBps = requireInt(obj, "commissionBps");
      if (!orgId) return json(400, { error: "orgId is required." });
      if (!kitId) return json(400, { error: "kitId is required." });
      if (!runId) return json(400, { error: "runId is required." });
      if (grossRoyaltyCents === undefined || grossRoyaltyCents < 0) {
        return json(400, { error: "grossRoyaltyCents must be a non-negative integer." });
      }
      if (commissionBps === undefined || commissionBps < 0) {
        return json(400, { error: "commissionBps must be a non-negative integer." });
      }
      await ledger.accrueRoyalty({ orgId, kitId, runId, grossRoyaltyCents, commissionBps, now });
      return json(200, { ok: true });
    }

    // ---- getPendingSellerEarnings (P2 payout job) -------------------------
    if (sub === "/seller-earnings/pending" && ctx.method === "GET") {
      const pending = await ledger.getPendingSellerEarnings();
      return json(200, { pending });
    }

    // ---- markSellerEarningsTransferred (P2 payout job) --------------------
    // Idempotent per transferRef.
    if (sub === "/seller-earnings/transferred" && ctx.method === "POST") {
      const obj = asObject(ctx.body);
      if (!obj) return json(400, { error: "Request body must be a JSON object." });
      const orgId = requireString(obj, "orgId");
      const amountCents = requireInt(obj, "amountCents");
      const transferRef = requireString(obj, "transferRef");
      if (!orgId) return json(400, { error: "orgId is required." });
      if (amountCents === undefined || amountCents < 0) {
        return json(400, { error: "amountCents must be a non-negative integer." });
      }
      if (!transferRef) return json(400, { error: "transferRef is required." });
      await ledger.markSellerEarningsTransferred(orgId, amountCents, transferRef, now);
      return json(200, { ok: true });
    }

    // Unknown ledger sub-route.
    return json(404, { error: "ledger_route_not_found" });
  } catch (error) {
    if (isInsufficientError(error)) {
      return json(402, { error: "insufficient_balance" });
    }
    // Never echo internal detail to the caller.
    return json(500, {
      error: "ledger_operation_failed",
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}
