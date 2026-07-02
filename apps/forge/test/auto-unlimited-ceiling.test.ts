// Regression — UNLIMITED (0) approval ceiling (server/core/auto.ts).
//
// Auto-web approvals inherit the resolved default run budget, whose system
// default is 0 = UNLIMITED, so approvals with maxBudgetCents = 0 exist in
// shared storage. The forge copy of the Auto composition root must stay
// consistent:
//   1. createApproval accepts maxBudgetCents = 0 (the unlimited sentinel);
//      negatives still rejected.
//   2. The startRun ceiling gate treats 0 as "no ceiling" — a positive run
//      budget under an unlimited approval is NOT rejected as over-ceiling.
//
// Mirrors test/auto-phase-c.test.ts: jose + cookie auth + storage +
// provider/ledger are mocked so nothing touches AWS/Anthropic; the dispatcher
// is a no-op.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- mock jose so any bearer-route import runs offline -----------------------
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  createRemoteJWKSet: () => "JWKS_HANDLE"
}));

// --- mock the cookie auth helper ---------------------------------------------
const requireUserMock = vi.fn();
class FakeUnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
vi.mock("@/lib/auth", () => ({
  UnauthorizedError: FakeUnauthorizedError,
  requireUserForApi: () => requireUserMock()
}));

// --- in-memory storage stub injected into server/core/auto --------------------
type Approval = {
  id: string;
  userId: string;
  kitRef: { source: string; localKitId?: string };
  toolAllowlist: string[];
  maxBudgetCents: number;
  networkPolicy: unknown;
  createdAt: string;
  revokedAt: string | null;
};
type Run = { id: string; userId: string; status: string; budgetCents: number; createdAt: string } & Record<
  string,
  unknown
>;

function makeStorage() {
  const approvals: Approval[] = [];
  const runs: Run[] = [];
  return {
    state: { approvals, runs },
    deps: {
      approvals: {
        async getApprovalForKit(userId: string) {
          return approvals.find((a) => a.userId === userId && a.revokedAt === null);
        },
        async createApproval(input: Record<string, unknown>) {
          const a = { id: `appr-${approvals.length}`, revokedAt: null, ...input } as Approval;
          approvals.push(a);
          return a;
        },
        async listApprovalsByUser(userId: string) {
          return approvals.filter((a) => a.userId === userId);
        },
        async revokeApproval() {
          return undefined;
        }
      },
      runs: {
        async createRun(input: Record<string, unknown>) {
          const r = { id: `run-${runs.length}`, status: "queued", ...input } as Run;
          runs.push(r);
          return r;
        },
        async listRunsByUser(userId: string) {
          return runs.filter((r) => r.userId === userId);
        },
        async getRun(id: string) {
          return runs.find((r) => r.id === id);
        },
        async requestCancel() {}
      },
      webhooks: {},
      inputs: {},
      workspaces: {}
    }
  };
}

const storageRef = { current: makeStorage() };

const resolveProviderMock = vi.fn(async () => null as unknown);
vi.mock("@/server/store/user-settings", () => ({
  getUserSettingsStore: async () => ({ resolveProvider: (...a: unknown[]) => resolveProviderMock(...(a as [])) })
}));
const balanceMock = vi.fn(async () => 1_000_000);
const classifyKitMock = vi.fn(async () => ({ isProtected: false }));
vi.mock("@/server/core/protected-kits", () => ({
  classifyKit: (...a: unknown[]) => classifyKitMock(...(a as [])),
  resolveProtectedSystemPrompt: async () => "PROTECTED_PROMPT",
  resolveProtectedSystemPromptViaService: async () => ({ systemPrompt: "X", pricing: "free", onlineOnly: false })
}));
vi.mock("@/server/core/import-ops", () => ({
  createForwardingStore: () => ({
    async get() {
      return null;
    },
    async set() {},
    async clear() {}
  })
}));
vi.mock("@/server/core/gateway", () => ({
  getCreditLedger: () => ({}),
  getBalanceCents: (...a: unknown[]) => balanceMock(...(a as []))
}));
vi.mock("@agentkitforge/auto-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@agentkitforge/auto-core");
  return {
    ...actual,
    makeAutoDeps: () => storageRef.current.deps,
    createDynamoDBDocumentClient: () => ({})
  };
});
vi.mock("@agentkitforge/gateway-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@agentkitforge/gateway-core");
  return { ...actual, createManagedAnthropicProvider: () => ({}) };
});

function resetStorage() {
  storageRef.current.state.approvals.length = 0;
  storageRef.current.state.runs.length = 0;
}

const LOCAL_KIT = { source: "local", localKitId: "k" } as const;

async function noopDispatcher() {
  const auto = await import("@/server/core/auto");
  auto.setAutoDispatcher(async () => {});
}

describe("unlimited (0) approval ceiling — forge copy stays consistent", () => {
  beforeEach(async () => {
    requireUserMock.mockReset();
    resetStorage();
    resolveProviderMock.mockReset();
    resolveProviderMock.mockResolvedValue(null);
    classifyKitMock.mockReset();
    classifyKitMock.mockResolvedValue({ isProtected: false });
    balanceMock.mockReset();
    balanceMock.mockResolvedValue(1_000_000);
    await noopDispatcher();
  });
  afterEach(() => vi.restoreAllMocks());

  it("createApproval accepts maxBudgetCents = 0 (unlimited)", async () => {
    const auto = await import("@/server/core/auto");
    const approval = await auto.createApproval({
      userId: "user-1",
      kitRef: LOCAL_KIT,
      toolAllowlist: ["read_file"],
      maxBudgetCents: 0
    });
    expect(approval.maxBudgetCents).toBe(0);
    expect(storageRef.current.state.approvals).toHaveLength(1);
  });

  it("createApproval still rejects a negative ceiling", async () => {
    const auto = await import("@/server/core/auto");
    await expect(
      auto.createApproval({ userId: "user-1", kitRef: LOCAL_KIT, toolAllowlist: [], maxBudgetCents: -1 })
    ).rejects.toBeInstanceOf(auto.AutoValidationError);
    expect(storageRef.current.state.approvals).toHaveLength(0);
  });

  it("startRun with a positive budget under a 0-ceiling approval is NOT over-ceiling", async () => {
    const auto = await import("@/server/core/auto");
    storageRef.current.state.approvals.push({
      id: "appr-unlimited",
      userId: "user-1",
      kitRef: LOCAL_KIT,
      toolAllowlist: ["read_file"],
      maxBudgetCents: 0, // unlimited ceiling — must never block
      networkPolicy: { mode: "deny_all" },
      createdAt: new Date().toISOString(),
      revokedAt: null
    });
    const run = await auto.startRun({
      userId: "user-1",
      kitRef: LOCAL_KIT,
      prompt: "do the thing",
      budgetCents: 100,
      kitContext: {}
    });
    expect(run.status).toBe("queued");
    expect(storageRef.current.state.runs).toHaveLength(1);
    expect(storageRef.current.state.runs[0]!.budgetCents).toBe(100);
  });

  it("a POSITIVE ceiling still gates an over-budget run", async () => {
    const auto = await import("@/server/core/auto");
    storageRef.current.state.approvals.push({
      id: "appr-capped",
      userId: "user-1",
      kitRef: LOCAL_KIT,
      toolAllowlist: ["read_file"],
      maxBudgetCents: 50,
      networkPolicy: { mode: "deny_all" },
      createdAt: new Date().toISOString(),
      revokedAt: null
    });
    await expect(
      auto.startRun({
        userId: "user-1",
        kitRef: LOCAL_KIT,
        prompt: "do the thing",
        budgetCents: 100, // > 50 ceiling
        kitContext: {}
      })
    ).rejects.toThrow(/exceeds the approval ceiling/);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });
});
