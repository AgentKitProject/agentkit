// Per-run budget resolution for AgentKitAuto.
//
// Runs/schedules/webhooks/approvals NO LONGER ask for a per-run budget. Instead
// the budget is resolved server-side at CREATE time with this precedence:
//
//   org override (Market, Seam S) → the user's OWN default → system fallback.
//
// The existing per-run cutoff (a run stops when spentInferenceCents >= budgetCents,
// in @agentkitforge/auto-core run-driver.ts) then enforces the cap automatically.
//
// The user's own default lives in the shared UserSettingsStore under
// `preferences.defaultRunBudgetCents` (so every adapter — disk / aws / selfhost —
// stores it identically via the existing setPreferences/getPublic surface). The
// org override is resolved via the fails-open Market service resolver.
import { getUserSettingsStore } from "@/server/store/user-settings";
import { resolveOrgRunBudget } from "@/server/core/run-budget-client";

/**
 * System fallback when neither an org override nor a user default is set.
 * 0 = UNLIMITED — the run is not given a separate per-run cap; at run-create time
 * `startRun` resolves 0 to the kit's approval ceiling (the per-kit safety cap the
 * user already set), so "unlimited" means "use the full approved budget" rather
 * than an arbitrary floor. Org/user-set budgets + org monthly limits still apply.
 * An approval created while this resolves to 0 stores maxBudgetCents = 0 — the
 * documented UNLIMITED ceiling sentinel (never blocks a run); when BOTH the run
 * budget and the ceiling are unlimited, startRun caps the run at
 * UNLIMITED_RUN_FALLBACK_CAP_CENTS (auto.ts) because the run-driver's cutoff +
 * v2 hold/settle billing require a positive per-run number.
 */
export const SYSTEM_DEFAULT_RUN_BUDGET_CENTS = 0; // unlimited (→ approval ceiling)

/** Key under UserSettings.preferences where the user's own default budget lives. */
const USER_DEFAULT_BUDGET_PREF_KEY = "defaultRunBudgetCents";

/**
 * The user's OWN default per-run budget (US cents), or undefined when they have
 * not set one. Read from the shared settings store preferences.
 */
export async function getUserDefaultRunBudgetCents(userId: string): Promise<number | undefined> {
  const store = await getUserSettingsStore();
  const settings = await store.getPublic(userId);
  const raw = settings.preferences?.[USER_DEFAULT_BUDGET_PREF_KEY];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * Set the user's OWN default per-run budget (US cents). Persisted in the shared
 * settings store preferences (alongside provider configs). 0 CLEARS the default
 * (back to unlimited) — `getUserDefaultRunBudgetCents` treats a non-positive
 * stored value as unset, so resolution falls through to the unlimited system
 * default (which run-create resolves to the approval ceiling).
 */
export async function setUserDefaultRunBudgetCents(userId: string, budgetCents: number): Promise<void> {
  if (!Number.isInteger(budgetCents) || budgetCents < 0) {
    throw new Error("budgetCents must be a non-negative integer (US cents); 0 = unlimited.");
  }
  const store = await getUserSettingsStore();
  await store.setPreferences(userId, { [USER_DEFAULT_BUDGET_PREF_KEY]: budgetCents });
}

/**
 * Resolve the effective per-run budget (US cents) for a user at run-create time.
 * Precedence: org override → user default → UNLIMITED (0 → the approval ceiling,
 * resolved in startRun). The org resolver FAILS OPEN, so a Market outage degrades
 * to the user default.
 */
export async function resolveRunBudgetCents(userId: string): Promise<number> {
  const orgOverride = await resolveOrgRunBudget(userId);
  if (orgOverride !== undefined) return orgOverride;
  const userDefault = await getUserDefaultRunBudgetCents(userId);
  if (userDefault !== undefined) return userDefault;
  return SYSTEM_DEFAULT_RUN_BUDGET_CENTS;
}
