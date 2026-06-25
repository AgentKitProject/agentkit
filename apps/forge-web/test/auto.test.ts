// AgentKitAuto Phase A — bearer route auth gate.
//
// AUTH — the BEARER route (/api/forge/auto/runs) with no bearer → 401 and never
// touches storage (jose mocked so no JWKS fetch). The cookie sibling has been
// removed (Auto is a standalone app); only the device-bearer route remains.
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mock jose so the bearer route's auth gate runs offline -------------------
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  createRemoteJWKSet: () => "JWKS_HANDLE"
}));

// --- mock the cookie auth helper so the cookie route runs offline -------------
// FULL mock (no importActual) — importActual would pull in @workos-inc/authkit-
// nextjs, which fails to resolve next/cache under vitest. We re-declare the
// UnauthorizedError the routes branch on inside the factory.
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
type Approval = { id: string; userId: string; kitRef: unknown; toolAllowlist: string[]; maxBudgetCents: number; networkPolicy: string; createdAt: string; revokedAt: string | null };
type Run = { id: string; userId: string; status: string; budgetCents: number; createdAt: string };

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
        async requestCancel() {
          /* no-op */
        }
      },
      workspaces: {}
    }
  };
}

// Mock the storage + provider/ledger composition so no AWS/Anthropic is touched.
// makeAutoDeps is mocked to return our in-memory storage, so getAutoStorage()
// (called internally by server/core/auto's startRun) never reaches DynamoDB.
const storageRef = { current: makeStorage() };

// --- billing-mode resolution stubs -------------------------------------------
// resolveAutoBilling reads the user's BYO provider + (for protected kits) the
// Market classification + (for BYO cloud) the prepaid balance. Stub all three so
// the route tests stay offline and we can steer the billing path.
const resolveProviderMock = vi.fn(async () => null as unknown);
vi.mock("@/server/store/user-settings", () => ({
  getUserSettingsStore: async () => ({ resolveProvider: (...a: unknown[]) => resolveProviderMock(...(a as [])) })
}));
const balanceMock = vi.fn(async () => 1_000_000);
const classifyKitMock = vi.fn(async () => ({ isProtected: false }));
vi.mock("@/server/core/protected-kits", () => ({
  classifyKit: (...a: unknown[]) => classifyKitMock(...(a as [])),
  resolveProtectedSystemPrompt: async () => "PROTECTED_PROMPT"
}));
// The cookie forwarding store imports the AuthKit-coupled import-ops module
// (which fails to resolve next/cache under vitest). Stub it.
vi.mock("@/server/core/import-ops", () => ({
  createForwardingStore: () => ({ async get() { return null; }, async set() {}, async clear() {} })
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
  // Reset in place (the getAutoStorage singleton caches storageRef.current.deps).
  storageRef.current.state.approvals.length = 0;
  storageRef.current.state.runs.length = 0;
}

describe("auto runs — auth split", () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
    requireUserMock.mockReset();
    resetStorage();
  });

  it("BEARER POST /api/forge/auto/runs without a bearer → 401", async () => {
    const { POST } = await import("@/app/api/forge/auto/runs/route");
    const req = new Request("https://forge.example/api/forge/auto/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kitRef: { source: "local", localKitId: "k" }, budgetCents: 10, prompt: "go" })
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });
});
