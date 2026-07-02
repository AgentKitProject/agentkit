/**
 * checkAffordability (core/services/affordability.ts) — the READ-ONLY
 * canStartRun verdict. Proves:
 *   - estimate composition per mode: managed = invocation + first-minute +
 *     inference floor; byo = invocation + first-minute only;
 *   - the free tier counts: remaining free active-minutes → allowed even at
 *     zero balance; exhausted allowance → the minute + floor must be funded;
 *   - unmetered deployment (both run-fee rates 0) → always allowed, floor NOT
 *     applied (a self-host is never gated);
 *   - the NO-MUTATION guarantee: no account rows, holds, or transactions are
 *     created by a check (and existing balances are untouched);
 *   - the floor env override (GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS).
 */

import { describe, it, expect } from "vitest";
import {
  checkAffordability,
  estimateRunStartCents,
  resolveManagedInferenceFloorCents,
  utcYearMonth,
  MANAGED_INFERENCE_FLOOR_CENTS,
  type RunStartPricing,
} from "../src/core/services/affordability.js";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

const NOW = "2026-07-02T12:00:00.000Z";
const YM = "2026-07";

/** Illustrative mechanism-test rates — NOT commercial values. */
const RATES: RunStartPricing = {
  invocationFeeCents: 1,
  activeMinuteRateCents: 1,
  freeActiveMinutesPerMonth: 60,
};
const NO_FREE: RunStartPricing = { ...RATES, freeActiveMinutesPerMonth: 0 };
const ZERO: RunStartPricing = {
  invocationFeeCents: 0,
  activeMinuteRateCents: 0,
  freeActiveMinutesPerMonth: 0,
};
const FLOOR = 5;

async function fundedLedger(userId: string, cents: number) {
  const ledger = new InMemoryCreditLedgerRepository();
  await ledger.ensureAccount(userId, NOW);
  if (cents > 0) await ledger.topup(userId, cents, NOW);
  return ledger;
}

describe("estimateRunStartCents", () => {
  it("managed = invocation + first minute + floor", () => {
    expect(estimateRunStartCents("managed", NO_FREE, FLOOR)).toBe(1 + 1 + 5);
  });

  it("byo = invocation + first minute only (no floor)", () => {
    expect(estimateRunStartCents("byo", NO_FREE, FLOOR)).toBe(1 + 1);
  });

  it("remaining free minutes waive the first-minute component", () => {
    expect(estimateRunStartCents("managed", RATES, FLOOR, 10)).toBe(1 + 0 + 5);
    expect(estimateRunStartCents("byo", RATES, FLOOR, 10)).toBe(1);
  });

  it("unmetered rates → 0 regardless of mode (floor not applied)", () => {
    expect(estimateRunStartCents("managed", ZERO, FLOOR)).toBe(0);
    expect(estimateRunStartCents("byo", ZERO, FLOOR)).toBe(0);
  });

  it("defaults the floor to MANAGED_INFERENCE_FLOOR_CENTS", () => {
    expect(estimateRunStartCents("managed", NO_FREE)).toBe(
      1 + 1 + MANAGED_INFERENCE_FLOOR_CENTS,
    );
  });
});

describe("checkAffordability — managed", () => {
  it("allows when the balance covers invocation + minute + floor", async () => {
    const ledger = await fundedLedger("u1", 7);
    const verdict = await checkAffordability(
      { ledger, pricing: NO_FREE, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "managed", now: NOW },
    );
    expect(verdict).toEqual({ allowed: true });
  });

  it("allows a ZERO-balance user with free minutes remaining (free tier counts)", async () => {
    const ledger = new InMemoryCreditLedgerRepository(); // no account at all
    const verdict = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u-free", mode: "managed", now: NOW },
    );
    expect(verdict.allowed).toBe(true);
  });

  it("denies a broke user whose free allowance is exhausted", async () => {
    const ledger = await fundedLedger("u1", 6); // needs 7 (1+1+5)
    await ledger.consumeFreeActiveMinutes("u1", YM, 60, 60, "run-past");
    const verdict = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "managed", now: NOW },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("insufficient_funds");
    expect(verdict.detail).toContain("7c");
  });

  it("denies a user with NO account row when fees are due (balance reads 0)", async () => {
    const ledger = new InMemoryCreditLedgerRepository();
    const verdict = await checkAffordability(
      { ledger, pricing: NO_FREE, managedInferenceFloorCents: FLOOR },
      { userId: "ghost", mode: "managed", now: NOW },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("insufficient_funds");
  });
});

describe("checkAffordability — byo", () => {
  it("preflights only OUR fees: invocation + first minute, no floor", async () => {
    const ledger = await fundedLedger("u1", 2); // exactly invocation + minute
    await ledger.consumeFreeActiveMinutes("u1", YM, 60, 60, "run-past");
    const byo = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "byo", now: NOW },
    );
    expect(byo).toEqual({ allowed: true });
    // The SAME balance fails managed (floor applies there).
    const managed = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "managed", now: NOW },
    );
    expect(managed.allowed).toBe(false);
  });

  it("allows a zero-balance BYO user with free minutes remaining", async () => {
    const ledger = new InMemoryCreditLedgerRepository();
    const verdict = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u-free", mode: "byo", now: NOW },
    );
    expect(verdict.allowed).toBe(true);
  });
});

describe("checkAffordability — unmetered / overrides", () => {
  it("always allows on an unmetered deployment (self-host: rates all zero)", async () => {
    const ledger = new InMemoryCreditLedgerRepository();
    for (const mode of ["managed", "byo"] as const) {
      const verdict = await checkAffordability(
        { ledger, pricing: ZERO, managedInferenceFloorCents: FLOOR },
        { userId: "anyone", mode, now: NOW },
      );
      expect(verdict).toEqual({ allowed: true });
    }
  });

  it("honors an explicit estimateCents override", async () => {
    const ledger = await fundedLedger("u1", 10);
    await ledger.consumeFreeActiveMinutes("u1", YM, 60, 60, "run-past");
    const deps = { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR };
    expect(
      (await checkAffordability(deps, { userId: "u1", mode: "managed", estimateCents: 10, now: NOW }))
        .allowed,
    ).toBe(true);
    expect(
      (await checkAffordability(deps, { userId: "u1", mode: "managed", estimateCents: 11, now: NOW }))
        .allowed,
    ).toBe(false);
  });
});

describe("checkAffordability — no-mutation guarantee", () => {
  it("creates NO account, hold, or transaction for an unknown user", async () => {
    const ledger = new InMemoryCreditLedgerRepository();
    await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "ghost", mode: "managed", now: NOW },
    );
    expect(ledger.accounts.size).toBe(0);
    expect(ledger.holds.size).toBe(0);
    expect(ledger.txns.length).toBe(0);
  });

  it("leaves an existing account's balances untouched", async () => {
    const ledger = await fundedLedger("u1", 42);
    const txnsBefore = ledger.txns.length;
    await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "managed", now: NOW },
    );
    const account = await ledger.getAccount("u1");
    expect(account?.availableBalanceCents).toBe(42);
    expect(account?.heldBalanceCents).toBe(0);
    expect(ledger.txns.length).toBe(txnsBefore);
    expect(ledger.holds.size).toBe(0);
  });
});

describe("resolveManagedInferenceFloorCents / utcYearMonth", () => {
  it("defaults to MANAGED_INFERENCE_FLOOR_CENTS", () => {
    expect(resolveManagedInferenceFloorCents({})).toBe(MANAGED_INFERENCE_FLOOR_CENTS);
  });

  it("honors a valid GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS (including 0)", () => {
    expect(
      resolveManagedInferenceFloorCents({ GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS: "12" }),
    ).toBe(12);
    expect(
      resolveManagedInferenceFloorCents({ GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS: "0" }),
    ).toBe(0);
  });

  it("falls back to the default on garbage", () => {
    for (const bad of ["-1", "abc", "1.5", ""]) {
      expect(
        resolveManagedInferenceFloorCents({ GATEWAY_MANAGED_INFERENCE_FLOOR_CENTS: bad }),
      ).toBe(MANAGED_INFERENCE_FLOOR_CENTS);
    }
  });

  it("utcYearMonth keys the UTC month", () => {
    expect(utcYearMonth("2026-07-02T12:00:00.000Z")).toBe("2026-07");
    expect(utcYearMonth("2026-01-31T23:59:59.999Z")).toBe("2026-01");
  });
});
