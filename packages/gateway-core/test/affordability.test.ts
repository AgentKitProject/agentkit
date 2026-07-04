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
  FREE_TRIAL_PERIOD_KEY,
  MANAGED_INFERENCE_FLOOR_CENTS,
  type RunStartPricing,
} from "../src/core/services/affordability.js";
import { InMemoryCreditLedgerRepository } from "../src/adapters/memory/credit-ledger.js";

const NOW = "2026-07-02T12:00:00.000Z";
const YM = FREE_TRIAL_PERIOD_KEY; // the trial uses the fixed lifetime key

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

  it("remaining free minutes waive invocation AND first minute (truly-free trial)", () => {
    // Only the managed inference floor remains — the trial is genuinely free
    // of run fees; a BYO run with free minutes needs nothing at all.
    expect(estimateRunStartCents("managed", RATES, FLOOR, 10)).toBe(0 + 0 + 5);
    expect(estimateRunStartCents("byo", RATES, FLOOR, 10)).toBe(0);
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

  it("adds the premium royalty on top of the compute estimate (M6)", () => {
    // managed: invocation + minute + floor + royalty
    expect(estimateRunStartCents("managed", NO_FREE, FLOOR, 0, 50)).toBe(1 + 1 + 5 + 50);
    // byo: invocation + minute (no floor) + royalty
    expect(estimateRunStartCents("byo", NO_FREE, FLOOR, 0, 50)).toBe(1 + 1 + 50);
  });

  it("royalty SURVIVES the free trial (seller price is not a run fee)", () => {
    // Free minutes waive invocation + first minute + (managed) leave only floor,
    // but the royalty is NEVER waived by the trial.
    expect(estimateRunStartCents("managed", RATES, FLOOR, 10, 50)).toBe(0 + 0 + 5 + 50);
    expect(estimateRunStartCents("byo", RATES, FLOOR, 10, 50)).toBe(0 + 50);
  });

  it("royalty applies even on an unmetered deployment (a paid kit still owes its price)", () => {
    expect(estimateRunStartCents("managed", ZERO, FLOOR, 0, 50)).toBe(50);
    expect(estimateRunStartCents("byo", ZERO, FLOOR, 0, 50)).toBe(50);
  });

  it("0 royalty is byte-identical to omitting it", () => {
    expect(estimateRunStartCents("managed", NO_FREE, FLOOR, 0, 0)).toBe(
      estimateRunStartCents("managed", NO_FREE, FLOOR, 0),
    );
    expect(estimateRunStartCents("byo", ZERO, FLOOR, 0, 0)).toBe(
      estimateRunStartCents("byo", ZERO, FLOOR, 0),
    );
  });

  it("clamps a negative royalty to 0", () => {
    expect(estimateRunStartCents("byo", ZERO, FLOOR, 0, -5)).toBe(0);
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

describe("checkAffordability — premium royalty (M6)", () => {
  it("requires balance ≥ compute + royalty and 402s before dispatch when short", async () => {
    // Compute estimate (managed, no free) = 1+1+5 = 7; royalty = 50 → needs 57.
    const short = await fundedLedger("buyer", 56);
    await short.consumeFreeActiveMinutes("buyer", YM, 60, 60, "run-past");
    const denied = await checkAffordability(
      { ledger: short, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "buyer", mode: "managed", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("insufficient_funds");
    expect(denied.detail).toContain("57c"); // compute 7 + royalty 50

    // One more cent and it's affordable.
    const ok = await fundedLedger("buyer2", 57);
    await ok.consumeFreeActiveMinutes("buyer2", YM, 60, 60, "run-past");
    const allowed = await checkAffordability(
      { ledger: ok, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "buyer2", mode: "managed", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(allowed).toEqual({ allowed: true });
  });

  it("0 royalty is byte-identical to today (a non-premium run is unchanged)", async () => {
    // Exactly-7 balance allows a managed run with royalty 0, exactly as before.
    const ledger = await fundedLedger("u1", 7);
    await ledger.consumeFreeActiveMinutes("u1", YM, 60, 60, "run-past");
    const withZero = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "managed", premiumRoyaltyCents: 0, now: NOW },
    );
    const without = await checkAffordability(
      { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "u1", mode: "managed", now: NOW },
    );
    expect(withZero).toEqual({ allowed: true });
    expect(withZero).toEqual(without);
  });

  it("the free trial does NOT waive the royalty — a $0-balance BYO trial user still needs it", async () => {
    // Zero balance, full trial remaining, BYO (no managed inference floor). The
    // trial waives the run FEES, but the seller royalty is not → the run is
    // refused until the buyer funds the royalty. BYO isolates the royalty (no
    // floor), so exactly 50c is due.
    const broke = new InMemoryCreditLedgerRepository();
    const denied = await checkAffordability(
      { ledger: broke, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "trial-user", mode: "byo", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("insufficient_funds");
    expect(denied.detail).toContain("50c"); // only the royalty is due under the trial

    // Fund exactly the royalty → allowed even with run fees waived by the trial.
    const funded = await fundedLedger("trial-funded", 50);
    const allowed = await checkAffordability(
      { ledger: funded, pricing: RATES, managedInferenceFloorCents: FLOOR },
      { userId: "trial-funded", mode: "byo", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(allowed).toEqual({ allowed: true });
  });

  it("charges the royalty even on an unmetered deployment (self-host running a paid kit)", async () => {
    // Rates all zero (self-host), but a premium kit still owes its price.
    const broke = new InMemoryCreditLedgerRepository();
    const denied = await checkAffordability(
      { ledger: broke, pricing: ZERO, managedInferenceFloorCents: FLOOR },
      { userId: "sh", mode: "managed", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(denied.allowed).toBe(false);
    const funded = await fundedLedger("sh2", 50);
    const allowed = await checkAffordability(
      { ledger: funded, pricing: ZERO, managedInferenceFloorCents: FLOOR },
      { userId: "sh2", mode: "managed", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(allowed).toEqual({ allowed: true });
  });

  it("adds the royalty on top of an explicit estimateCents override", async () => {
    const ledger = await fundedLedger("u1", 60);
    await ledger.consumeFreeActiveMinutes("u1", YM, 60, 60, "run-past");
    const deps = { ledger, pricing: RATES, managedInferenceFloorCents: FLOOR };
    // override 10 (compute) + royalty 50 = 60 → exactly affordable.
    expect(
      (await checkAffordability(deps, { userId: "u1", mode: "managed", estimateCents: 10, premiumRoyaltyCents: 50, now: NOW })).allowed,
    ).toBe(true);
    // override 11 + royalty 50 = 61 → over.
    expect(
      (await checkAffordability(deps, { userId: "u1", mode: "managed", estimateCents: 11, premiumRoyaltyCents: 50, now: NOW })).allowed,
    ).toBe(false);
  });

  it("makes NO mutations while checking a premium run", async () => {
    const ledger = new InMemoryCreditLedgerRepository();
    await checkAffordability(
      { ledger, pricing: ZERO, managedInferenceFloorCents: FLOOR },
      { userId: "ghost", mode: "managed", premiumRoyaltyCents: 50, now: NOW },
    );
    expect(ledger.accounts.size).toBe(0);
    expect(ledger.holds.size).toBe(0);
    expect(ledger.txns.length).toBe(0);
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
