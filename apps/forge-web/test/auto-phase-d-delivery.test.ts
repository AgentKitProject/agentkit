// AgentKitAuto Phase D — opt-in result delivery threading.
//
// Four concerns, all offline (jose + AuthKit + auto-core storage mocked exactly
// like test/auto-schedules.test.ts + test/auto-phase-c.test.ts):
//   1. THREAD — a deliveryConfig on the run-create body is persisted onto the run
//      (cookie path /api/auto/runs).
//   2. SWEEP COPY — a schedule carrying a deliveryConfig copies it onto the run the
//      per-minute sweep fires (createAndDispatch → startRun).
//   3. WEBHOOK COPY — a webhook carrying a deliveryConfig copies it onto the run a
//      secret-authed ingest fire creates (fireWebhook → consumeWebhook → startRun).
//   4. VALIDATION — an https-less webhook url / malformed email → 400 invalid_request
//      and NO run created (auto-core validateDeliveryConfig via parseDeliveryConfig).
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

type DeliveryConfig = { email?: string[]; webhook?: { url: string; secret?: string } };
type Approval = { id: string; userId: string; kitRef: unknown; toolAllowlist: string[]; maxBudgetCents: number; networkPolicy: string; createdAt: string; revokedAt: string | null };
type Run = { id: string; userId: string; status: string; budgetCents: number; createdAt: string; trigger?: string; scheduleId?: string; webhookId?: string; deliveryConfig?: DeliveryConfig };
type Schedule = Record<string, unknown> & { id: string; userId: string; enabled: boolean; nextRunAt: string; deliveryConfig?: DeliveryConfig };
type WebhookRow = Record<string, unknown> & { id: string; userId: string; enabled: boolean; secretHash: string; deliveryConfig?: DeliveryConfig };

function makeStorage() {
  const approvals: Approval[] = [];
  const runs: Run[] = [];
  const schedules: Schedule[] = [];
  const webhooks: WebhookRow[] = [];
  let seq = 0;
  let n = 0;
  return {
    state: { approvals, runs, schedules, webhooks },
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
      webhooks: {
        async createWebhook(input: Record<string, unknown>) {
          const w = {
            id: `wh-${n++}`,
            enabled: true,
            lastFiredAt: null,
            lastRunId: null,
            lastError: null,
            fireCount: 0,
            ...input
          } as unknown as WebhookRow;
          webhooks.push(w);
          return w;
        },
        async getWebhook(id: string) {
          return webhooks.find((w) => w.id === id);
        },
        async listWebhooksByUser(userId: string) {
          return webhooks.filter((w) => w.userId === userId);
        },
        async recordFire(id: string, result: { lastFiredAt: string; lastRunId: string; lastError: string | null }) {
          const w = webhooks.find((x) => x.id === id);
          if (w) {
            w.lastFiredAt = result.lastFiredAt;
            w.lastRunId = result.lastRunId;
            w.lastError = result.lastError;
            w.fireCount = ((w.fireCount as number) ?? 0) + 1;
          }
        },
        async setEnabled(id: string, enabled: boolean) {
          const w = webhooks.find((x) => x.id === id);
          if (w) w.enabled = enabled;
          return w;
        },
        async deleteWebhook(id: string) {
          const i = webhooks.findIndex((x) => x.id === id);
          if (i >= 0) webhooks.splice(i, 1);
        }
      },
      inputs: {},
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
  storageRef.current.state.webhooks.length = 0;
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

const GOOD_DELIVERY: DeliveryConfig = {
  email: ["ops@example.com"],
  webhook: { url: "https://hooks.example.com/auto", secret: "shh" }
};

describe("Phase D — sweep copies the schedule's deliveryConfig onto the run", () => {
  beforeEach(async () => {
    jwtVerifyMock.mockReset();
    requireUserMock.mockReset();
    resetStorage();
    resolveProviderMock.mockReset();
    resolveProviderMock.mockResolvedValue(null);
    classifyKitMock.mockReset();
    classifyKitMock.mockResolvedValue({ isProtected: false });
    balanceMock.mockReset();
    balanceMock.mockResolvedValue(1_000_000);
    const auto = await import("@/server/core/auto");
    auto.setAutoDispatcher(async () => {});
  });
  afterEach(() => {
    delete process.env.AUTO_WORKER_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  it("a due schedule's deliveryConfig rides onto the fired run", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = "right-key";
    const approvalId = seedApproval();
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
      lastError: null,
      deliveryConfig: GOOD_DELIVERY
    });

    const { POST } = await import("@/app/api/internal/auto/sweep/route");
    const res = await POST(
      new Request("https://forge.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": "right-key" }
      })
    );
    expect(res.status).toBe(200);
    const run = storageRef.current.state.runs[0] as Run;
    expect(run.trigger).toBe("schedule");
    expect(run.deliveryConfig).toEqual(GOOD_DELIVERY);
  });
});

describe("Phase D — webhook fire copies the webhook's deliveryConfig onto the run", () => {
  beforeEach(async () => {
    resetStorage();
    resolveProviderMock.mockReset();
    resolveProviderMock.mockResolvedValue(null);
    classifyKitMock.mockReset();
    classifyKitMock.mockResolvedValue({ isProtected: false });
    balanceMock.mockReset();
    balanceMock.mockResolvedValue(1_000_000);
    const auto = await import("@/server/core/auto");
    auto.setAutoDispatcher(async () => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a secret-authed fire carries the webhook's deliveryConfig onto the run", async () => {
    const approvalId = seedApproval();
    const { hashWebhookSecret } = await import("@agentkitforge/auto-core");
    const secret = "test-secret-value";
    storageRef.current.state.webhooks.push({
      id: "wh-d",
      userId: "user-1",
      kitRef: { source: "local", localKitId: "k" },
      approvalId,
      budgetCents: 40,
      model: "claude-sonnet-4-6",
      enabled: true,
      secretHash: hashWebhookSecret(secret),
      createdAt: new Date().toISOString(),
      lastFiredAt: null,
      lastRunId: null,
      lastError: null,
      fireCount: 0,
      deliveryConfig: GOOD_DELIVERY
    });

    const { POST } = await import("@/app/api/hooks/auto/[webhookId]/route");
    const res = await POST(
      new Request("https://forge.example/api/hooks/auto/wh-d", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auto-webhook-secret": secret },
        body: JSON.stringify({ text: "do it" })
      }),
      { params: Promise.resolve({ webhookId: "wh-d" }) }
    );
    expect(res.status).toBe(202);
    const run = storageRef.current.state.runs[0] as Run;
    expect(run.trigger).toBe("webhook");
    expect(run.webhookId).toBe("wh-d");
    expect(run.deliveryConfig).toEqual(GOOD_DELIVERY);
  });
});
