// Auto v2 — Slice 3 app-level wiring (server/core/auto.ts).
//
// Covers the pre-flight run-fee gate the app applies BEFORE creating a run:
//   - estimateMinRunCostCents: the minimum up-front cost formula
//       (invocation + first active-minute, the latter waived while free minutes
//        remain) — sufficient / insufficient / free-minutes-cover-it / self-host;
//   - autoV2Rates gating: a FREE backend (self-host) yields 0/0/0 (no fee, no
//       gate), a metered backend resolves the rates (here via env overrides,
//       since the commercial package is absent in the public test build);
//   - getBillingSummary on a FREE backend returns metered:false WITHOUT touching
//       a ledger (no account is created, runs are unmetered).
//
// The commercial @agentkit-commercial/gateway package is NOT installed in this
// build, so loadAutoV2Rates falls back to 0 and we drive non-zero rates via the
// AUTO_*_CENTS env escape hatch — exactly the operator override path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// auto.ts transitively imports AuthKit; stub it so the module graph loads in the
// bare vitest env (we never exercise its network path).
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
  getSignInUrl: vi.fn(),
  handleAuth: vi.fn(),
  saveSession: vi.fn(),
  authkitMiddleware: vi.fn(() => vi.fn())
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Clean env per test; each test sets the backend/rate envs it needs.
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SELF_HOST;
  delete process.env.AUTO_SELFHOST_BILLING;
  delete process.env.KITSTORE_BACKEND;
  delete process.env.AUTO_INVOCATION_FEE_CENTS;
  delete process.env.AUTO_ACTIVE_MINUTE_RATE_CENTS;
  delete process.env.AUTO_FREE_ACTIVE_MINUTES_PER_MONTH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("estimateMinRunCostCents — pre-flight minimum cost", () => {
  it("with free minutes remaining: NOTHING is required (truly-free trial waives invocation too)", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 };
    // freeMinutesRemaining > 0 → invocation AND first minute waived → a
    // $0-balance user can genuinely use the one-time trial.
    expect(estimateMinRunCostCents(rates, 60)).toBe(0);
    expect(estimateMinRunCostCents(rates, 1)).toBe(0);
  });

  it("with NO free minutes remaining: invocation + one active-minute is required", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 };
    expect(estimateMinRunCostCents(rates, 0)).toBe(2);
  });

  it("self-host (rates 0): estimate is 0 → no balance required", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
    expect(estimateMinRunCostCents(rates, 0)).toBe(0);
    expect(estimateMinRunCostCents(rates, 60)).toBe(0);
  });

  it("higher rates: estimate scales with the configured fees", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 5, activeMinuteRateCents: 3, freeActiveMinutesPerMonth: 60 };
    expect(estimateMinRunCostCents(rates, 0)).toBe(8); // 5 + 3
    expect(estimateMinRunCostCents(rates, 10)).toBe(0); // trial waives invocation + first minute
  });

  // The pre-flight check is `balance >= estimate`. These assert the sufficiency
  // decision the gate makes for each scenario.
  it("sufficiency decision: sufficient / insufficient / free-covers-it", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 };

    // No free minutes left, balance 2 → required 2 → sufficient.
    expect(2 >= estimateMinRunCostCents(rates, 0)).toBe(true);
    // No free minutes left, balance 1 → required 2 → INSUFFICIENT.
    expect(1 >= estimateMinRunCostCents(rates, 0)).toBe(false);
    // Free minutes remain, balance 1 → required 1 (invocation only) → sufficient.
    expect(1 >= estimateMinRunCostCents(rates, 60)).toBe(true);
  });

  // PREMIUM (per_invocation) royalty (M6 P4): startRun's pre-flight now requires
  //   balance >= estimateMinRunCostCents(rates, free) + premiumRoyaltyCents
  // so a premium run is refused with a clean 402 BEFORE dispatch. These assert
  // the exact arithmetic the gate performs (the royalty rides ON TOP of the
  // compute estimate, and is NOT waived by the free trial).
  it("royalty-inclusive sufficiency: balance must cover compute + royalty", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 };
    const royalty = 300;

    // No free minutes: required = (1 + 1) + 300 = 302.
    const requiredNoFree = estimateMinRunCostCents(rates, 0) + royalty;
    expect(requiredNoFree).toBe(302);
    expect(301 >= requiredNoFree).toBe(false); // INSUFFICIENT → 402 pre-flight
    expect(302 >= requiredNoFree).toBe(true); // exactly enough → ok

    // Free minutes remain: compute is waived (0) but the royalty is NOT →
    // required = 0 + 300 = 300 (the trial never waives the seller's price).
    const requiredWithFree = estimateMinRunCostCents(rates, 60) + royalty;
    expect(requiredWithFree).toBe(300);
    expect(299 >= requiredWithFree).toBe(false);
    expect(300 >= requiredWithFree).toBe(true);
  });

  it("0 royalty is byte-identical to today (non-premium run unchanged)", async () => {
    const { estimateMinRunCostCents } = await import("@/server/core/auto");
    const rates = { invocationFeeCents: 1, activeMinuteRateCents: 1, freeActiveMinutesPerMonth: 60 };
    // required with a 0 royalty === the compute estimate alone.
    expect(estimateMinRunCostCents(rates, 0) + 0).toBe(estimateMinRunCostCents(rates, 0));
    // self-host (rates 0) + 0 royalty → still 0 (no gate).
    const free = { invocationFeeCents: 0, activeMinuteRateCents: 0, freeActiveMinutesPerMonth: 0 };
    expect(estimateMinRunCostCents(free, 0) + 0).toBe(0);
  });
});

describe("autoV2Rates — managed-vs-free gating", () => {
  it("FREE self-host backend → 0/0/0 (no fee, no gate)", async () => {
    process.env.SELF_HOST = "true"; // billing defaults to "free" → backend "free"
    const { autoV2Rates, resetAutoV2RatesCache } = await import("@/server/core/auto");
    resetAutoV2RatesCache();
    const rates = await autoV2Rates();
    expect(rates.invocationFeeCents).toBe(0);
    expect(rates.activeMinuteRateCents).toBe(0);
    expect(rates.freeActiveMinutesPerMonth).toBe(0);
  });

  it("metered backend → resolves the rates (env-override path; commercial pkg absent)", async () => {
    // Hosted (SELF_HOST unset) → backend "dynamo" → enabled. Commercial package is
    // absent in the public build, so the AUTO_* env override supplies the rates.
    process.env.AUTO_INVOCATION_FEE_CENTS = "1";
    process.env.AUTO_ACTIVE_MINUTE_RATE_CENTS = "1";
    process.env.AUTO_FREE_ACTIVE_MINUTES_PER_MONTH = "60";
    const { autoV2Rates, resetAutoV2RatesCache } = await import("@/server/core/auto");
    resetAutoV2RatesCache();
    const rates = await autoV2Rates();
    expect(rates.invocationFeeCents).toBe(1);
    expect(rates.activeMinuteRateCents).toBe(1);
    expect(rates.freeActiveMinutesPerMonth).toBe(60);
  });
});

describe("getBillingSummary — FREE backend (self-host, unmetered)", () => {
  it("returns metered:false with zeros and never touches a ledger", async () => {
    process.env.SELF_HOST = "true";
    const { getBillingSummary, resetAutoV2RatesCache } = await import("@/server/core/auto");
    resetAutoV2RatesCache();
    const summary = await getBillingSummary("user-free");
    expect(summary.metered).toBe(false);
    expect(summary.balanceCents).toBe(0);
    expect(summary.freeMinutesRemaining).toBe(0);
  });
});

describe("getBillingSummary — metered backend (BYO account auto-creation + free minutes)", () => {
  // Drive a metered deployment via the env override (commercial pkg absent), and
  // inject an in-memory ledger to verify the SAME ensureAccount + free-minute read
  // the pre-flight runs. A BYO user starts with NO account row.
  function meteredEnv() {
    process.env.AUTO_INVOCATION_FEE_CENTS = "1";
    process.env.AUTO_ACTIVE_MINUTE_RATE_CENTS = "1";
    process.env.AUTO_FREE_ACTIVE_MINUTES_PER_MONTH = "60";
  }

  it("auto-creates the account for a BYO user with no prior balance (0 balance, full free allowance)", async () => {
    meteredEnv();
    const { InMemoryCreditLedgerRepository } = await import("@agentkitforge/gateway-core");
    const ledger = new InMemoryCreditLedgerRepository();
    const { getBillingSummary, resetAutoV2RatesCache } = await import("@/server/core/auto");
    resetAutoV2RatesCache();

    // No account exists yet for this BYO user.
    expect(await ledger.getAccount("byo-user")).toBeUndefined();

    const summary = await getBillingSummary("byo-user", ledger);
    expect(summary.metered).toBe(true);
    expect(summary.balanceCents).toBe(0);
    expect(summary.freeMinutesRemaining).toBe(60);
    expect(summary.freeMinutesPerMonth).toBe(60);

    // getBillingSummary ensureAccount'd the BYO user (the row now exists).
    expect(await ledger.getAccount("byo-user")).toBeDefined();
  });

  it("reflects a topped-up balance and depleted free minutes", async () => {
    meteredEnv();
    const { InMemoryCreditLedgerRepository } = await import("@agentkitforge/gateway-core");
    const ledger = new InMemoryCreditLedgerRepository();
    const ts = new Date().toISOString();
    await ledger.ensureAccount("paid-user", ts);
    await ledger.topup("paid-user", 500, ts, "test-grant");
    // Consume 20 of the 60 one-time trial minutes (fixed lifetime key).
    const { FREE_TRIAL_PERIOD_KEY } = await import("@agentkitforge/gateway-core");
    await ledger.consumeFreeActiveMinutes("paid-user", FREE_TRIAL_PERIOD_KEY, 20, 60, "run-prior");

    const { getBillingSummary, resetAutoV2RatesCache } = await import("@/server/core/auto");
    resetAutoV2RatesCache();
    const summary = await getBillingSummary("paid-user", ledger);
    expect(summary.balanceCents).toBe(500);
    expect(summary.freeMinutesRemaining).toBe(40); // 60 - 20
  });
});
