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
