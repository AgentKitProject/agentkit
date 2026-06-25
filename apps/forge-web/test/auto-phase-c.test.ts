// AgentKitAuto Phase C — webhook triggers, network egress allowlist + http_fetch
// opt-in, user-provided run inputs, and the fourth (per-webhook-secret) auth path.
//
// Mirrors test/auto.test.ts: jose + cookie auth + storage + provider/ledger are
// mocked so nothing touches AWS/Anthropic. The auto-core engine itself
// (consumeWebhook, generate/hash/verifyWebhookSecret, normalizeNetworkPolicy) is
// the REAL implementation — we only stub the storage adapters + dispatcher.
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
type Run = { id: string; userId: string; status: string; budgetCents: number; createdAt: string } & Record<string, unknown>;
type WebhookRow = {
  id: string;
  userId: string;
  kitRef: { source: string; localKitId?: string };
  approvalId: string;
  budgetCents: number;
  model: string;
  enabled: boolean;
  secretHash: string;
  createdAt: string;
  lastFiredAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  fireCount: number;
};

function makeStorage() {
  const approvals: Approval[] = [];
  const runs: Run[] = [];
  const webhooks: WebhookRow[] = [];
  let n = 0;
  return {
    state: { approvals, runs, webhooks },
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
          } as WebhookRow;
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
            w.fireCount += 1;
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
  createForwardingStore: () => ({ async get() { return null; }, async set() {}, async clear() {} })
}));
vi.mock("@/server/core/gateway", () => ({
  getCreditLedger: () => ({}),
  getBalanceCents: (...a: unknown[]) => balanceMock(...(a as []))
}));
// presigner is only reached by the input upload-url route (which we drive with a
// configured bucket) — stub getSignedUrl so no real AWS call happens.
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_c: unknown, _cmd: unknown) => "https://s3.example/presigned-put"
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  }
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
  storageRef.current.state.webhooks.length = 0;
}

const LOCAL_KIT = { source: "local", localKitId: "k" } as const;
function seedApproval(maxBudgetCents = 100_000, networkPolicy: unknown = { mode: "deny_all" }) {
  storageRef.current.state.approvals.push({
    id: "appr-x",
    userId: "user-1",
    kitRef: LOCAL_KIT,
    toolAllowlist: ["read_file"],
    maxBudgetCents,
    networkPolicy,
    createdAt: new Date().toISOString(),
    revokedAt: null
  });
}

async function noopDispatcher() {
  const auto = await import("@/server/core/auto");
  auto.setAutoDispatcher(async () => {});
}

describe("Phase C — webhook ingest auth (fourth path: secret only)", () => {
  beforeEach(async () => {
    requireUserMock.mockReset();
    resetStorage();
    resolveProviderMock.mockReset();
    resolveProviderMock.mockResolvedValue(null);
    classifyKitMock.mockReset();
    classifyKitMock.mockResolvedValue({ isProtected: false });
    balanceMock.mockReset();
    balanceMock.mockResolvedValue(1_000_000);
    process.env.APP_URL = "https://forge.example";
    requireUserMock.mockResolvedValue({ id: "user-1", email: "u@example.com" });
    await noopDispatcher();
  });
  afterEach(() => vi.restoreAllMocks());

  /** Create a webhook via the core engine and return { id, secret }. */
  async function createWebhook(): Promise<{ id: string; secret: string }> {
    seedApproval();
    const approvalId = storageRef.current.state.approvals[0].id;
    const auto = await import("@/server/core/auto");
    const created = await auto.createWebhook({
      userId: "user-1",
      kitRef: LOCAL_KIT,
      budgetCents: 50,
      approvalId
    });
    return { id: created.webhook.id, secret: created.secret };
  }

  it("valid secret → 202 and creates a run with trigger 'webhook' + webhookId", async () => {
    const { id, secret } = await createWebhook();
    const { POST } = await import("@/app/api/hooks/auto/[webhookId]/route");
    const res = await POST(
      new Request(`https://forge.example/api/hooks/auto/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-auto-webhook-secret": secret },
        body: JSON.stringify({ text: "do the thing" })
      }),
      { params: Promise.resolve({ webhookId: id }) }
    );
    expect(res.status).toBe(202);
    const run = storageRef.current.state.runs[0];
    expect(run.trigger).toBe("webhook");
    expect(run.webhookId).toBe(id);
    // recordFire stamped the webhook.
    expect(storageRef.current.state.webhooks[0].fireCount).toBe(1);
    expect(storageRef.current.state.webhooks[0].lastRunId).toBe(run.id);
  });

  it("token query param also works (?token=)", async () => {
    const { id, secret } = await createWebhook();
    const { POST } = await import("@/app/api/hooks/auto/[webhookId]/route");
    const res = await POST(
      new Request(`https://forge.example/api/hooks/auto/${id}?token=${encodeURIComponent(secret)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "go" })
      }),
      { params: Promise.resolve({ webhookId: id }) }
    );
    expect(res.status).toBe(202);
  });

  it("bad secret → 401 and no run", async () => {
    const { id } = await createWebhook();
    const { POST } = await import("@/app/api/hooks/auto/[webhookId]/route");
    const res = await POST(
      new Request(`https://forge.example/api/hooks/auto/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-auto-webhook-secret": "wrong-secret" },
        body: "{}"
      }),
      { params: Promise.resolve({ webhookId: id }) }
    );
    expect(res.status).toBe(401);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });

  it("missing secret → 401", async () => {
    const { id } = await createWebhook();
    const { POST } = await import("@/app/api/hooks/auto/[webhookId]/route");
    const res = await POST(
      new Request(`https://forge.example/api/hooks/auto/${id}`, { method: "POST", body: "{}" }),
      { params: Promise.resolve({ webhookId: id }) }
    );
    expect(res.status).toBe(401);
  });

  it("disabled webhook → 401 and no run", async () => {
    const { id, secret } = await createWebhook();
    storageRef.current.state.webhooks[0].enabled = false;
    const { POST } = await import("@/app/api/hooks/auto/[webhookId]/route");
    const res = await POST(
      new Request(`https://forge.example/api/hooks/auto/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-auto-webhook-secret": secret },
        body: "{}"
      }),
      { params: Promise.resolve({ webhookId: id }) }
    );
    expect(res.status).toBe(401);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });
});

describe("Phase C — auth-path separation (webhook CRUD)", () => {
  beforeEach(() => {
    jwtVerifyMock.mockReset();
    requireUserMock.mockReset();
    resetStorage();
  });
  afterEach(() => vi.restoreAllMocks());

  it("BEARER POST /api/forge/auto/webhooks without a bearer → 401, no webhook", async () => {
    const { POST } = await import("@/app/api/forge/auto/webhooks/route");
    const res = await POST(
      new Request("https://forge.example/api/forge/auto/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kitRef: LOCAL_KIT, budgetCents: 50, approvalId: "appr-x" })
      })
    );
    expect(res.status).toBe(401);
    expect(storageRef.current.state.webhooks).toHaveLength(0);
  });
});
