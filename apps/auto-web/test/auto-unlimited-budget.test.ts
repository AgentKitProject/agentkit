// Regression — UNLIMITED (0) resolved run budget vs approvals (server/core/auto.ts).
//
// A fresh user (no org override, no user default) resolves the run budget to
// SYSTEM_DEFAULT_RUN_BUDGET_CENTS = 0 (unlimited). The approvals route feeds
// that straight into createApproval as the ceiling, so:
//   1. createApproval MUST accept maxBudgetCents = 0 (the documented unlimited
//      sentinel) — it used to reject it, 400-ing "Create approval" for every
//      fresh user until they set a default budget in Settings.
//   2. startRun under such an approval must NOT be spuriously rejected by the
//      ceiling gate, and the run it creates must carry a POSITIVE effective
//      budget (UNLIMITED_RUN_FALLBACK_CAP_CENTS when everything is unlimited)
//      so the run-driver's cutoff can't kill it instantly.
//
// Test-mode mirrors auto-extraction-guard.test.ts: the selfhost storage backend
// with stubbed pools + a stubbed auto-core makeAutoDeps, so getAutoStorage()
// returns fake approvals/runs repos and nothing touches Postgres/AWS/Anthropic.
// startRun is stopped right after createRun via a sentinel throw (staging +
// dispatch are out of scope here).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "user-1";
const KIT = { source: "local" as const, localKitId: "k1" };

type StoredApproval = {
  id: string;
  userId: string;
  kitRef: typeof KIT;
  scope: string;
  toolAllowlist: string[];
  networkPolicy: { mode: "deny_all" };
  maxBudgetCents: number;
  createdAt: string;
  revokedAt: string | null;
};

const approvals: StoredApproval[] = [];
const createRunInputs: Array<{ budgetCents: number }> = [];
const CREATE_RUN_SENTINEL = "STOP_AFTER_CREATE_RUN";

const createApprovalRepo = vi.fn(async (input: Record<string, unknown>) => {
  const a = { id: `appr-${approvals.length}`, revokedAt: null, ...input } as StoredApproval;
  approvals.push(a);
  return a;
});
const getApprovalForKit = vi.fn(async (userId: string) =>
  approvals.find((a) => a.userId === userId && a.revokedAt === null)
);
const createRun = vi.fn(async (input: { budgetCents: number }) => {
  createRunInputs.push(input);
  // Stop startRun here — staging/dispatch are not under test.
  throw new Error(CREATE_RUN_SENTINEL);
});

beforeEach(() => {
  vi.resetModules();
  approvals.length = 0;
  createRunInputs.length = 0;
  createApprovalRepo.mockClear();
  getApprovalForKit.mockClear();
  createRun.mockClear();
  process.env.KITSTORE_BACKEND = "selfhost";

  // auto.ts transitively imports AuthKit; stub so the module graph loads bare.
  vi.doMock("@workos-inc/authkit-nextjs", () => ({
    withAuth: vi.fn(),
    getSignInUrl: vi.fn(),
    handleAuth: vi.fn(),
    saveSession: vi.fn(),
    authkitMiddleware: vi.fn(() => vi.fn())
  }));

  // Stub the selfhost pool accessors (never actually connect).
  vi.doMock("@/server/store/selfhost-user-settings", () => ({
    getSelfHostPgPool: vi.fn(async () => ({})),
    getAutoRunPgPool: vi.fn(async () => ({}))
  }));

  // Org monthly-usage gate: fail open (no Profile service in tests).
  vi.doMock("@/server/core/org-usage-client", () => ({
    checkOrgUsage: vi.fn(async () => undefined),
    recordOrgUsage: vi.fn(async () => undefined)
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.KITSTORE_BACKEND;
});

async function loadAuto() {
  const realAutoCore = await vi.importActual<typeof import("@agentkitforge/auto-core")>(
    "@agentkitforge/auto-core"
  );
  vi.doMock("@agentkitforge/auto-core", () => ({
    ...realAutoCore,
    ensureAutoSchema: vi.fn(async () => {}),
    makeAutoDeps: vi.fn(() => ({
      runs: { createRun },
      approvals: { getApprovalForKit, createApproval: createApprovalRepo }
    }))
  }));
  return import("@/server/core/auto");
}

describe("createApproval — unlimited (0) resolved budget", () => {
  it("accepts maxBudgetCents = 0 (unlimited — the fresh-user resolved default)", async () => {
    const auto = await loadAuto();
    const approval = await auto.createApproval({
      userId: USER,
      kitRef: KIT,
      toolAllowlist: ["read_file"],
      maxBudgetCents: 0
    });
    expect(approval.maxBudgetCents).toBe(0);
    expect(createApprovalRepo).toHaveBeenCalledTimes(1);
  });

  it("still rejects a negative or non-integer ceiling", async () => {
    const auto = await loadAuto();
    await expect(
      auto.createApproval({ userId: USER, kitRef: KIT, toolAllowlist: [], maxBudgetCents: -1 })
    ).rejects.toBeInstanceOf(auto.AutoValidationError);
    await expect(
      auto.createApproval({ userId: USER, kitRef: KIT, toolAllowlist: [], maxBudgetCents: 1.5 })
    ).rejects.toBeInstanceOf(auto.AutoValidationError);
    expect(createApprovalRepo).not.toHaveBeenCalled();
  });
});

describe("startRun — unlimited (0) approval ceiling", () => {
  function seedUnlimitedApproval() {
    approvals.push({
      id: "appr-unlimited",
      userId: USER,
      kitRef: KIT,
      scope: "workspace_read_write",
      toolAllowlist: ["read_file"],
      networkPolicy: { mode: "deny_all" },
      maxBudgetCents: 0, // unlimited ceiling
      createdAt: "2026-07-01T00:00:00.000Z",
      revokedAt: null
    });
  }

  it("everything unlimited (run budget 0 + ceiling 0) → run gets the positive fallback cap", async () => {
    const auto = await loadAuto();
    seedUnlimitedApproval();
    await expect(
      auto.startRun({
        userId: USER,
        kitRef: KIT,
        prompt: "do the thing",
        budgetCents: 0, // unlimited (the resolved fresh-user default)
        kitContext: {},
        inferenceModeOverride: "managed"
      })
    ).rejects.toThrow(CREATE_RUN_SENTINEL); // reached createRun — the gate passed
    expect(createRunInputs).toHaveLength(1);
    expect(createRunInputs[0]!.budgetCents).toBe(auto.UNLIMITED_RUN_FALLBACK_CAP_CENTS);
    expect(auto.UNLIMITED_RUN_FALLBACK_CAP_CENTS).toBeGreaterThan(0);
  });

  it("a positive requested budget under an unlimited ceiling is used as-is (never 'over ceiling')", async () => {
    const auto = await loadAuto();
    seedUnlimitedApproval();
    await expect(
      auto.startRun({
        userId: USER,
        kitRef: KIT,
        prompt: "do the thing",
        budgetCents: 250,
        kitContext: {},
        inferenceModeOverride: "managed"
      })
    ).rejects.toThrow(CREATE_RUN_SENTINEL);
    expect(createRunInputs[0]!.budgetCents).toBe(250);
  });

  it("a POSITIVE ceiling still gates an over-budget run (403 path unchanged)", async () => {
    const auto = await loadAuto();
    approvals.push({
      id: "appr-capped",
      userId: USER,
      kitRef: KIT,
      scope: "workspace_read_write",
      toolAllowlist: ["read_file"],
      networkPolicy: { mode: "deny_all" },
      maxBudgetCents: 100,
      createdAt: "2026-07-01T00:00:00.000Z",
      revokedAt: null
    });
    await expect(
      auto.startRun({
        userId: USER,
        kitRef: KIT,
        prompt: "do the thing",
        budgetCents: 250, // > 100 ceiling
        kitContext: {},
        inferenceModeOverride: "managed"
      })
    ).rejects.toThrow(/exceeds the approval ceiling/);
    expect(createRun).not.toHaveBeenCalled();
  });
});
