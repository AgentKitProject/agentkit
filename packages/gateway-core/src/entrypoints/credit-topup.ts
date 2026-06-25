/**
 * Internal, service-key-gated credit-topup endpoint for the managed gateway.
 *
 * BOUNDARY: the Stripe webhook (Market app) is the only caller. It credits a
 * buyer's prepaid balance after a paid credit-pack Checkout. The gateway stays
 * the sole holder of its Postgres credentials — Market never opens a pool to the
 * `agentkitgateway` database. The webhook reaches the credit ledger ONLY through
 * this `POST /gateway/credits/topup` endpoint.
 *
 * AUTH: a shared `GATEWAY_SERVICE_KEY` (constant-time compared), NOT WorkOS. This
 * is a server-to-server trust seam, separate from the per-user WorkOS bearer auth
 * the metering routes use. The key is server-side only on both sides.
 *
 * IDEMPOTENCY: the handler delegates to `ledger.topup(userId, cents, now,
 * sourceRef)`, whose DB-enforced UNIQUE(source_ref) makes a redelivered
 * `stripe-cs-{id}` a no-op. The endpoint itself is therefore safe to call
 * repeatedly with the same `sourceRef` (Stripe webhook redelivery).
 *
 * This module is GENERIC (no Stripe, no commercial code): it takes an injected
 * `CreditLedgerRepository` (the hosted image injects the commercial Postgres
 * ledger via the existing loader seam) and an injected expected service key.
 */

import { timingSafeEqual } from "node:crypto";
import type { CreditLedgerRepository } from "../core/ports.js";
import type { CreditAccount } from "../core/types.js";
import type { GatewayJsonResponse } from "../core/router.js";

/** The internal topup route path. */
export const CREDIT_TOPUP_PATH = "/gateway/credits/topup";

/** Request body for a credit topup (validated structurally). */
export interface CreditTopupBody {
  userId: string;
  creditCents: number;
  sourceRef: string;
}

/** Dependencies for the credit-topup handler. */
export interface CreditTopupDeps {
  ledger: CreditLedgerRepository;
  /**
   * The expected `GATEWAY_SERVICE_KEY`. When undefined/empty the endpoint is
   * INERT and rejects every call with 503 (so a misconfigured deploy can never
   * accept unauthenticated topups). The hosted image injects the real key.
   */
  serviceKey: string | undefined;
  /** Clock. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /**
   * Minimum allowed topup in cents (defends against absurd/negative amounts at
   * the boundary). Defaults to 1; the composition root may pass MIN_TOPUP_CENTS.
   */
  minCents?: number;
}

/** Constant-time string comparison that does not leak length via early return. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still compare against a fixed-size buffer so timing does not reveal the
    // mismatch was a length mismatch; the result is unconditionally false.
    const filler = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, filler.length === bufA.length ? filler : bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function json(status: number, body: unknown): GatewayJsonResponse {
  return { kind: "json", status, body };
}

function parseBody(raw: unknown, minCents: number): CreditTopupBody | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Request body must be a JSON object." };
  const obj = raw as Record<string, unknown>;
  const userId = obj["userId"];
  const creditCents = obj["creditCents"];
  const sourceRef = obj["sourceRef"];
  if (typeof userId !== "string" || userId.trim() === "") return { error: "userId is required." };
  if (typeof sourceRef !== "string" || sourceRef.trim() === "") return { error: "sourceRef is required." };
  if (typeof creditCents !== "number" || !Number.isInteger(creditCents)) {
    return { error: "creditCents must be an integer." };
  }
  if (creditCents < minCents) return { error: `creditCents must be at least ${minCents}.` };
  return { userId, creditCents, sourceRef };
}

/**
 * Handles a credit-topup request. Returns a JSON gateway response. The host
 * supplies the parsed JSON body and the raw `Authorization: Bearer <key>` (or
 * `x-gateway-service-key`) value via `providedKey`.
 *
 * Status codes:
 *   - 503 when the endpoint is not configured (no serviceKey)
 *   - 401 when no key is provided
 *   - 403 when the key is wrong
 *   - 400 on a malformed body
 *   - 200 with the resulting account on success (idempotent on sourceRef)
 */
export async function handleCreditTopup(
  deps: CreditTopupDeps,
  providedKey: string | null | undefined,
  body: unknown,
): Promise<GatewayJsonResponse> {
  const { serviceKey } = deps;
  if (!serviceKey || serviceKey.trim() === "") {
    return json(503, { error: "credit_topup_not_configured" });
  }
  if (providedKey === null || providedKey === undefined || providedKey === "") {
    return json(401, { error: "missing_service_key" });
  }
  if (!constantTimeEqual(providedKey, serviceKey)) {
    return json(403, { error: "invalid_service_key" });
  }

  const minCents = deps.minCents ?? 1;
  const parsed = parseBody(body, minCents);
  if ("error" in parsed) {
    return json(400, { error: parsed.error });
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  let account: CreditAccount;
  try {
    account = await deps.ledger.topup(parsed.userId, parsed.creditCents, now, parsed.sourceRef);
  } catch (error) {
    // Never echo internal detail to the caller.
    return json(500, { error: "topup_failed", message: error instanceof Error ? error.message : "unknown" });
  }

  return json(200, {
    ok: true,
    userId: account.userId,
    availableBalanceCents: account.availableBalanceCents,
    lifetimeTopupCents: account.lifetimeTopupCents,
  });
}

/**
 * Extracts the service key from a request's headers. Accepts either
 * `Authorization: Bearer <key>` or `x-gateway-service-key: <key>`. Returns null
 * when neither is present.
 */
export function extractServiceKey(headers: {
  authorization?: string | string[] | undefined;
  serviceKeyHeader?: string | string[] | undefined;
}): string | null {
  const direct = Array.isArray(headers.serviceKeyHeader)
    ? headers.serviceKeyHeader[0]
    : headers.serviceKeyHeader;
  if (direct && direct.trim() !== "") return direct.trim();

  const auth = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    const token = match?.[1]?.trim();
    if (token && token.length > 0) return token;
  }
  return null;
}
