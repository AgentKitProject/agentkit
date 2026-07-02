// AgentKitAuto Phase B — schedule CRUD validation, route auth split, and the
// service-key sweep (createAndDispatch reuses startRun + sets trigger/scheduleId).
//
// Mirrors test/auto.test.ts: jose + the cookie auth helper are mocked so the
// routes run offline, and makeAutoDeps is mocked to an in-memory storage stub
// (now including a schedules repo). The REAL auto-core cron + runDueSchedules are
// used (importActual) so we exercise the genuine scheduling engine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- mock jose so the bearer route's auth gate runs offline -------------------
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  createRemoteJWKSet: () => "JWKS_HANDLE"
}));

// --- mock the cookie auth helper so the cookie route runs offline -------------
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
type Approval = { id: string; userId: string; kitRef: { source: string; localKitId?: string }; toolAllowlist: string[]; maxBudgetCents: number; networkPolicy: string; createdAt: string; revokedAt: string | null };
type Run = { id: string; userId: string; status: string; budgetCents: number; createdAt: string; trigger?: string; scheduleId?: string };
type Schedule = {
  id: string; userId: string; kitRef: { source: string; localKitId?: string }; cron: string; timezone: string;
  input: { prompt: string }; budgetCents: number; model: string; approvalId: string; enabled: boolean;
  createdAt: string; updatedAt: string; lastRunAt: string | null; lastRunId: string | null; nextRunAt: string; lastError: string | null;
};

function makeStorage() {
  const approvals: Approval[] = [];
  const runs: Run[] = [];
  const schedules: Schedule[] = [];
  let seq = 0;
  return {
    state: { approvals, runs, schedules },
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
      schedules: {
        async createSchedule(input: Record<string, unknown>) {
          const s = {
            id: `sched-${seq++}`,
            enabled: (input as { enabled?: boolean }).enabled ?? true,
            updatedAt: (input as { createdAt: string }).createdAt,
            lastRunAt: null,
            lastRunId: null,
            lastError: null,
            ...input
          } as unknown as Schedule;
          schedules.push(s);
          return s;
        },
        async getSchedule(id: string) {
          return schedules.find((s) => s.id === id);
        },
        async listSchedulesByUser(userId: string) {
          return schedules.filter((s) => s.userId === userId);
        },
        async listDueSchedules(nowISO: string) {
          return schedules.filter((s) => s.enabled && s.nextRunAt <= nowISO);
        },
        async updateSchedule(id: string, patch: Record<string, unknown>) {
          const s = schedules.find((x) => x.id === id);
          if (!s) return undefined;
          Object.assign(s, patch);
          return s;
        },
        async setScheduleRunResult(id: string, result: Record<string, unknown>) {
          const s = schedules.find((x) => x.id === id);
          if (s) Object.assign(s, result);
        },
        async deleteSchedule(id: string) {
          const i = schedules.findIndex((x) => x.id === id);
          if (i >= 0) schedules.splice(i, 1);
        }
      },
      workspaces: {}
    }
  };
}

const storageRef = { current: makeStorage() };

// --- billing-mode resolution stubs (offline) ----------------------------------
const resolveProviderMock = vi.fn(async () => null as unknown);
vi.mock("@/server/store/user-settings", () => ({
  getUserSettingsStore: async () => ({ resolveProvider: (...a: unknown[]) => resolveProviderMock(...(a as [])) })
}));
const balanceMock = vi.fn(async () => 1_000_000);
const classifyKitMock = vi.fn(async () => ({ isProtected: false }));
vi.mock("@/server/core/protected-kits", () => ({
  classifyKit: (...a: unknown[]) => classifyKitMock(...(a as [])),
  resolveProtectedSystemPrompt: async () => "PROTECTED_PROMPT",
  resolveProtectedSystemPromptViaService: async () => ({ systemPrompt: "P", pricing: "free", onlineOnly: false })
}));
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
  storageRef.current.state.approvals.length = 0;
  storageRef.current.state.runs.length = 0;
  storageRef.current.state.schedules.length = 0;
}

function seedApproval(maxBudgetCents = 1000): string {
  storageRef.current.state.approvals.push({
    id: "appr-x",
    userId: "user-1",
    kitRef: { source: "local", localKitId: "k" },
    toolAllowlist: ["read_file"],
    maxBudgetCents,
    networkPolicy: "deny_all",
    createdAt: new Date().toISOString(),
    revokedAt: null
  });
  return "appr-x";
}

describe("auto schedules — auth split", () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
    requireUserMock.mockReset();
    resetStorage();
  });

  it("BEARER POST /api/forge/auto/schedules without a bearer → 401 (no schedule created)", async () => {
    const { POST } = await import("@/app/api/forge/auto/schedules/route");
    const req = new Request("https://forge.example/api/forge/auto/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kitRef: { source: "local", localKitId: "k" }, cron: "0 9 * * *", prompt: "go", budgetCents: 50, approvalId: "appr-x" })
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(storageRef.current.state.schedules).toHaveLength(0);
  });
});

describe("auto schedules — sweep endpoint (service-key path)", () => {
  beforeEach(() => {
    resetStorage();
    resolveProviderMock.mockReset();
    resolveProviderMock.mockResolvedValue(null);
    classifyKitMock.mockReset();
    classifyKitMock.mockResolvedValue({ isProtected: false });
    balanceMock.mockReset();
    balanceMock.mockResolvedValue(1_000_000);
    delete process.env.AUTO_WORKER_SERVICE_KEY;
  });
  afterEach(() => {
    delete process.env.AUTO_WORKER_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  it("503 when AUTO_WORKER_SERVICE_KEY is unset", async () => {
    const { POST } = await import("@/app/api/internal/auto/sweep/route");
    const res = await POST(new Request("https://forge.example/api/internal/auto/sweep", { method: "POST" }));
    expect(res.status).toBe(503);
  });

  it("401 on a wrong service key", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = "right-key";
    const { POST } = await import("@/app/api/internal/auto/sweep/route");
    const res = await POST(
      new Request("https://forge.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": "wrong-key" }
      })
    );
    expect(res.status).toBe(401);
  });

  it("200 with the right key; createAndDispatch creates a run with trigger='schedule' + scheduleId", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = "right-key";
    // Use the in-process dispatcher no-op so the run isn't actually executed.
    const auto = await import("@/server/core/auto");
    auto.setAutoDispatcher(async () => {});

    const approvalId = seedApproval();
    // A due schedule (nextRunAt in the past) for our approved kit.
    storageRef.current.state.schedules.push({
      id: "sched-due",
      userId: "user-1",
      kitRef: { source: "local", localKitId: "k" },
      cron: "* * * * *",
      timezone: "UTC",
      input: { prompt: "scheduled task" },
      budgetCents: 40,
      model: "claude-sonnet-4-6",
      approvalId,
      enabled: true,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
      lastRunAt: null,
      lastRunId: null,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      lastError: null
    });

    const { POST } = await import("@/app/api/internal/auto/sweep/route");
    const res = await POST(
      new Request("https://forge.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": "right-key" }
      })
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { processed: number; dispatched: number; skipped: number; errors: unknown[] };
    expect(summary.processed).toBe(1);
    expect(summary.dispatched).toBe(1);

    // The created run carries the schedule provenance.
    const run = storageRef.current.state.runs[0] as Run;
    expect(run).toBeTruthy();
    expect(run.trigger).toBe("schedule");
    expect(run.scheduleId).toBe("sched-due");

    // nextRunAt was advanced past now (double-fire prevention) → no longer due.
    const sched = storageRef.current.state.schedules[0] as Schedule;
    expect(new Date(sched.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(sched.lastRunId).toBe(run.id);
  });

  it("a due schedule whose approval was revoked is SKIPPED, not dispatched", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = "right-key";
    const auto = await import("@/server/core/auto");
    auto.setAutoDispatcher(async () => {});
    // No approval seeded → the gate skips.
    storageRef.current.state.schedules.push({
      id: "sched-noappr",
      userId: "user-1",
      kitRef: { source: "local", localKitId: "k" },
      cron: "* * * * *",
      timezone: "UTC",
      input: { prompt: "x" },
      budgetCents: 40,
      model: "claude-sonnet-4-6",
      approvalId: "gone",
      enabled: true,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
      lastRunAt: null,
      lastRunId: null,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      lastError: null
    });
    const { POST } = await import("@/app/api/internal/auto/sweep/route");
    const res = await POST(
      new Request("https://forge.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": "right-key" }
      })
    );
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { dispatched: number; skipped: number };
    expect(summary.dispatched).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });
});
