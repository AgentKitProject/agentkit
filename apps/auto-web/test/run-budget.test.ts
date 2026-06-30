// Precedence test for server/core/run-budget.ts resolveRunBudgetCents().
//
// resolveRunBudgetCents(userId) resolves the effective per-run budget with:
//   org override (Market, fails-open) → the user's own default → system fallback (50¢).
//
// We mock the two dependencies: the Market org-budget resolver (run-budget-client)
// and the shared UserSettingsStore (for the user's own default). vi.resetModules()
// + dynamic import keeps each case isolated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "user-budget-test-1";

// Mutable doubles the mocked modules read on each call.
let orgOverride: number | undefined;
let userPreferences: Record<string, unknown> | undefined;

vi.mock("@/server/core/run-budget-client", () => ({
  resolveOrgRunBudget: vi.fn(async () => orgOverride)
}));

vi.mock("@/server/store/user-settings", () => ({
  getUserSettingsStore: vi.fn(async () => ({
    getPublic: async () => ({ providers: [], preferences: userPreferences }),
    setPreferences: vi.fn(async () => {})
  }))
}));

async function loadSubject() {
  const mod = await import("@/server/core/run-budget");
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  orgOverride = undefined;
  userPreferences = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRunBudgetCents — precedence org > user > fallback", () => {
  it("uses the org override when present (wins over user default)", async () => {
    orgOverride = 300;
    userPreferences = { defaultRunBudgetCents: 150 };
    const { resolveRunBudgetCents } = await loadSubject();
    await expect(resolveRunBudgetCents(USER_ID)).resolves.toBe(300);
  });

  it("uses the user default when there is no org override", async () => {
    orgOverride = undefined;
    userPreferences = { defaultRunBudgetCents: 150 };
    const { resolveRunBudgetCents } = await loadSubject();
    await expect(resolveRunBudgetCents(USER_ID)).resolves.toBe(150);
  });

  it("falls back to the unlimited system default (0) when neither is set", async () => {
    orgOverride = undefined;
    userPreferences = undefined;
    const { resolveRunBudgetCents, SYSTEM_DEFAULT_RUN_BUDGET_CENTS } = await loadSubject();
    await expect(resolveRunBudgetCents(USER_ID)).resolves.toBe(SYSTEM_DEFAULT_RUN_BUDGET_CENTS);
    // 0 = unlimited (run-create resolves it to the kit's approval ceiling).
    expect(SYSTEM_DEFAULT_RUN_BUDGET_CENTS).toBe(0);
  });

  it("ignores a non-positive / non-integer stored user default (→ unlimited fallback)", async () => {
    orgOverride = undefined;
    userPreferences = { defaultRunBudgetCents: 0 };
    const { resolveRunBudgetCents } = await loadSubject();
    await expect(resolveRunBudgetCents(USER_ID)).resolves.toBe(0);

    vi.resetModules();
    userPreferences = { defaultRunBudgetCents: 12.5 };
    const again = await loadSubject();
    await expect(again.resolveRunBudgetCents(USER_ID)).resolves.toBe(0);
  });

  it("getUserDefaultRunBudgetCents returns undefined when unset, the value when set", async () => {
    userPreferences = undefined;
    let mod = await loadSubject();
    await expect(mod.getUserDefaultRunBudgetCents(USER_ID)).resolves.toBeUndefined();

    vi.resetModules();
    userPreferences = { defaultRunBudgetCents: 250 };
    mod = await loadSubject();
    await expect(mod.getUserDefaultRunBudgetCents(USER_ID)).resolves.toBe(250);
  });
});
