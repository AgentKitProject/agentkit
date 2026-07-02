/**
 * HTTP-backed credit ledger for AgentKitAuto.
 *
 * Auto used to debit the credit ledger by importing the COMMERCIAL package
 * (`@agentkit-commercial/gateway`) and opening its OWN `pg` pool against the
 * gateway's Postgres database (`GATEWAY_DATABASE_URL`). That coupled the
 * open-core Auto images to the commercial package and to the gateway's DB
 * credentials.
 *
 * This client moves that seam over HTTP: every ledger op goes to the gateway's
 * service-key-gated `/gateway/ledger/*` endpoints. The gateway stays the sole
 * holder of its DB credentials and the only place the commercial ledger (the
 * moat) runs. Auto-core no longer imports `@agentkit-commercial/gateway` and no
 * longer touches `GATEWAY_DATABASE_URL`.
 *
 * It implements `CreditLedgerRepository`, but ONLY the subset Auto actually
 * calls at runtime (the union of run-driver's direct calls and the calls inside
 * gateway-core's `runManagedTurn`):
 *   ensureAccount, getAccount, debit, reserveHold, settleHold, releaseHold,
 *   getFreeMinutesUsed, consumeFreeActiveMinutes.
 * The remaining port methods (topup, recordTransaction, getHold,
 * listTransactions) are NEVER called by Auto, so they throw a clear error rather
 * than pretend over HTTP.
 *
 * SERVER STAMPS NOW: the ledger methods take `now: string`, but over HTTP the
 * GATEWAY stamps `now` server-side (never trust a client clock). The `now`
 * argument these methods receive is therefore IGNORED and never sent.
 *
 * Security: a failed request surfaces ONLY the HTTP status, never the response
 * body (which could echo internal detail).
 */

import type {
  CreditAccount,
  CreditHold,
  CreditLedgerRepository,
  CreditTransaction,
  RecordTransactionInput,
} from "@agentkitforge/gateway-core";

/** Config for the HTTP ledger client. */
export interface HttpLedgerClientConfig {
  /** Gateway internal base URL, e.g. http://agentkitgateway (no trailing slash needed). */
  baseUrl: string;
  /** Shared service key (sent as `x-gateway-service-key`). */
  serviceKey: string;
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The Auto v2 run-pricing the gateway serves over HTTP. */
export interface AutoV2RatesResponse {
  invocationFeeCents: number;
  activeMinuteRateCents: number;
  freeActiveMinutesPerMonth: number;
}

/** Request body for the gateway's READ-ONLY affordability pre-check
 *  (`POST /gateway/ledger/can-start`) — mirrors contracts'
 *  canStartRunRequestSchema. */
export interface CanStartRunCheckRequest {
  userId: string;
  /** Billing mode of the prospective run. */
  mode: "managed" | "byo";
}

/** The gateway's affordability verdict — mirrors contracts'
 *  canStartRunResponseSchema. `ledger_unavailable` is never produced by the
 *  gateway itself; callers map THIS CLIENT's transport/HTTP errors to it. */
export interface CanStartRunCheckResponse {
  allowed: boolean;
  reason?: "insufficient_funds" | "ledger_unavailable";
  detail?: string;
}

function notSupported(method: string): never {
  throw new Error(
    `[auto-core] HttpLedgerClient.${method} is not supported over HTTP — Auto never calls it. ` +
      `Only ensureAccount/getAccount/debit/reserveHold/settleHold/releaseHold/` +
      `getFreeMinutesUsed/consumeFreeActiveMinutes are served by the gateway ledger endpoints.`,
  );
}

/**
 * An HTTP client for the gateway's `/gateway/ledger/*` endpoints that satisfies
 * `CreditLedgerRepository` for the Auto run path.
 */
export class HttpLedgerClient implements CreditLedgerRepository {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpLedgerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.serviceKey = config.serviceKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private url(path: string, query?: Record<string, string>): string {
    const base = `${this.baseUrl}/gateway/ledger${path}`;
    if (!query) return base;
    const qs = new URLSearchParams(query).toString();
    return qs ? `${base}?${qs}` : base;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-gateway-service-key": this.serviceKey,
    };
  }

  /** POST a JSON body; returns the parsed JSON on 2xx. Throws on non-2xx (status only). */
  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // NEVER include the body — it may carry internal detail.
      throw new Error(`gateway ledger ${path} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  /** GET; returns the parsed JSON on 2xx, or undefined on 404. Throws on other non-2xx. */
  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    const res = await this.fetchImpl(this.url(path, query), {
      method: "GET",
      headers: { "x-gateway-service-key": this.serviceKey },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`gateway ledger ${path} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  // ---- Implemented over HTTP -------------------------------------------------

  async ensureAccount(userId: string, _now: string): Promise<CreditAccount> {
    return (await this.post("/ensure-account", { userId })) as CreditAccount;
  }

  async getAccount(userId: string): Promise<CreditAccount | undefined> {
    return (await this.get("/account", { userId })) as CreditAccount | undefined;
  }

  async debit(
    userId: string,
    amountCents: number,
    _now: string,
    description?: string,
    sourceRef?: string,
  ): Promise<CreditAccount> {
    return (await this.post("/debit", {
      userId,
      amountCents,
      ...(description !== undefined ? { description } : {}),
      ...(sourceRef !== undefined ? { sourceRef } : {}),
    })) as CreditAccount;
  }

  async reserveHold(userId: string, maxCostCents: number, _now: string): Promise<string> {
    const body = (await this.post("/holds", { userId, maxCostCents })) as { holdId: string };
    return body.holdId;
  }

  async settleHold(
    holdId: string,
    actualCostCents: number,
    _now: string,
    sourceRef?: string,
  ): Promise<CreditAccount> {
    return (await this.post("/holds/settle", {
      holdId,
      actualCostCents,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
    })) as CreditAccount;
  }

  async releaseHold(holdId: string, _now: string): Promise<CreditAccount> {
    return (await this.post("/holds/release", { holdId })) as CreditAccount;
  }

  async getFreeMinutesUsed(userId: string, yearMonth: string): Promise<number> {
    const body = (await this.get("/free-minutes", { userId, yearMonth })) as { usedMinutes: number };
    return body.usedMinutes;
  }

  async consumeFreeActiveMinutes(
    userId: string,
    yearMonth: string,
    runActiveMinutes: number,
    freeAllowance: number,
    runId: string,
  ): Promise<number> {
    const body = (await this.post("/consume-free-minutes", {
      userId,
      yearMonth,
      runActiveMinutes,
      freeAllowance,
      runId,
    })) as { billableMinutes: number };
    return body.billableMinutes;
  }

  /**
   * READ-ONLY affordability pre-check: asks the gateway whether `userId` can
   * afford to start a `mode` run right now (`POST /gateway/ledger/can-start`).
   * Returns the gateway's verdict on 2xx; THROWS on any transport/HTTP failure
   * (status only, no body leak) — callers map that error to the contracts'
   * `ledger_unavailable` reason (fail-closed for managed per
   * CAN_START_FAIL_CLOSED_MODES, open for BYO). Mutates nothing.
   */
  async canStartRun(input: CanStartRunCheckRequest): Promise<CanStartRunCheckResponse> {
    const body = (await this.post("/can-start", {
      userId: input.userId,
      mode: input.mode,
    })) as CanStartRunCheckResponse;
    return {
      allowed: body.allowed === true,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
    };
  }

  /**
   * Fetches the Auto v2 run-pricing from the gateway (the moat values are served
   * by the gateway, gated on the same service key). Returns 0/0/0 on any failure
   * so Auto NEVER charges when the rates can't be read.
   */
  async fetchAutoV2Rates(): Promise<AutoV2RatesResponse> {
    try {
      const body = (await this.get("/auto-v2-rates", {})) as AutoV2RatesResponse | undefined;
      if (!body) {
        return { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
      }
      return {
        invocationFeeCents: Math.max(0, body.invocationFeeCents ?? 0),
        activeMinuteRateCents: Math.max(0, body.activeMinuteRateCents ?? 0),
        freeActiveMinutesPerMonth: Math.max(0, body.freeActiveMinutesPerMonth ?? 0),
      };
    } catch {
      // Never charge on failure.
      return { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
    }
  }

  // ---- Not called by Auto over HTTP -----------------------------------------

  async topup(): Promise<CreditAccount> {
    return notSupported("topup");
  }

  async recordTransaction(_input: RecordTransactionInput): Promise<CreditTransaction> {
    return notSupported("recordTransaction");
  }

  async getHold(_holdId: string): Promise<CreditHold | undefined> {
    return notSupported("getHold");
  }

  async listTransactions(_userId: string, _limit?: number): Promise<CreditTransaction[]> {
    return notSupported("listTransactions");
  }
}
