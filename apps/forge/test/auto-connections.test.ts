// Wave 3a APPS layer — Connections CRUD + verify probe + persisted-output
// downloads over the BEARER auth path (server/core/auto-connections.ts,
// /api/forge/auto/connections* + /api/forge/auto/runs/[id]/outputs/[...path]).
//
// Mirrors test/auto-events.test.ts conventions: jose + storage are mocked; the
// MECHANISM (schema validation, SSRF guard, secret handling) is the REAL
// auto-core implementation — only storage + network seams are injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- mock jose so the bearer route's auth gate runs offline -------------------
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
  createRemoteJWKSet: () => "JWKS_HANDLE"
}));

// --- mock the cookie auth helper (some transitive imports touch it) -----------
class FakeUnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
vi.mock("@/lib/auth", () => ({
  UnauthorizedError: FakeUnauthorizedError,
  requireUserForApi: vi.fn()
}));

// --- offline seams --------------------------------------------------------------
vi.mock("@/server/store/user-settings", () => ({
  getUserSettingsStore: async () => ({ resolveProvider: async () => null })
}));
vi.mock("@/server/core/protected-kits", () => ({
  classifyKit: async () => ({ isProtected: false }),
  resolveProtectedSystemPrompt: async () => "PROTECTED_PROMPT",
  resolveProtectedSystemPromptViaService: async () => ({ systemPrompt: "X", pricing: "free", onlineOnly: false })
}));
vi.mock("@/server/core/import-ops", () => ({
  createForwardingStore: () => ({ async get() { return null; }, async set() {}, async clear() {} })
}));
vi.mock("@/server/core/gateway", () => ({ getCreditLedger: () => ({}) }));

// --- in-memory storage (connections + secrets + runs + outputs) ----------------
type Row = Record<string, unknown>;

function makeStorage() {
  const runs: Row[] = [];
  const connections = new Map<string, Row>();
  const secrets = { configured: true, map: new Map<string, string>(), deletes: [] as string[], seq: 0 };
  let n = 0;

  const deps = {
    approvals: {},
    runs: {
      async getRun(id: string) {
        return runs.find((r) => r.id === id);
      },
      async listRunsByUser(userId: string) {
        return runs.filter((r) => r.userId === userId);
      }
    },
    schedules: {},
    webhooks: {},
    inputs: {},
    workspaces: {},
    outputs: {
      async putRunOutput() {
        return "unused";
      },
      async presignGet(storeKey: string) {
        return `https://signed.example/${storeKey}?sig=test`;
      },
      async delete() {}
    },
    events: {
      triggers: {},
      eventSources: {},
      receivedEvents: {},
      fireLogs: {},
      secrets: {
        async put(plaintext: string) {
          if (!secrets.configured) {
            const err = new Error("unconfigured");
            err.name = "SecretStoreUnconfiguredError";
            throw err;
          }
          const ref = `sref-${++secrets.seq}`;
          secrets.map.set(ref, plaintext);
          return ref;
        },
        async reveal(ref: string) {
          const v = secrets.map.get(ref);
          if (v === undefined) throw new Error(`unknown ref ${ref}`);
          return v;
        },
        async delete(ref: string) {
          secrets.deletes.push(ref);
          secrets.map.delete(ref);
        }
      },
      connections: {
        async createConnection(input: Row) {
          const c: Row = {
            id: `conn-${++n}`,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            name: input.name,
            type: input.type,
            config: input.config,
            secretRef: input.secretRef ?? null,
            status: "unverified",
            createdAt: input.createdAt
          };
          connections.set(c.id as string, c);
          return structuredClone(c);
        },
        async getConnection(id: string) {
          const c = connections.get(id);
          return c ? structuredClone(c) : undefined;
        },
        async listConnectionsByOwner(ownerType: string, ownerId: string) {
          return [...connections.values()]
            .filter((c) => c.ownerType === ownerType && c.ownerId === ownerId)
            .map((c) => structuredClone(c));
        },
        async updateConnection(id: string, patch: Row) {
          const c = connections.get(id);
          if (!c) return undefined;
          for (const k of ["name", "config", "secretRef"]) {
            if (patch[k] !== undefined) c[k] = patch[k];
          }
          return structuredClone(c);
        },
        async setConnectionStatus(id: string, status: string, lastUsedAt?: string) {
          const c = connections.get(id);
          if (!c) return;
          c.status = status;
          if (lastUsedAt !== undefined) c.lastUsedAt = lastUsedAt;
        },
        async deleteConnection(id: string) {
          connections.delete(id);
        }
      }
    }
  };

  /** In-place reset: server/core/auto.ts caches the deps OBJECT (singleton),
   *  so tests must clear the same instance rather than swap it out. */
  const reset = () => {
    runs.length = 0;
    connections.clear();
    secrets.map.clear();
    secrets.deletes.length = 0;
    secrets.configured = true;
    secrets.seq = 0;
  };

  return { deps, reset, state: { runs, connections, secrets } };
}

const storageRef = { current: makeStorage() };

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

const SECRET = "AKIAEXAMPLE:super-secret-value";
const AUTH = { authorization: "Bearer test.token.here" };

function connBody(over: Record<string, unknown> = {}) {
  return {
    name: "backup bucket",
    type: "s3",
    config: { bucket: "my-bucket", region: "us-east-1" },
    secret: SECRET,
    ...over
  };
}

async function createViaRoute(
  body: Record<string, unknown> = connBody(),
  headers: Record<string, string> = AUTH
): Promise<Response> {
  const { POST } = await import("@/app/api/forge/auto/connections/route");
  return POST(
    new Request("https://forge.example/api/forge/auto/connections", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    })
  );
}

beforeEach(async () => {
  jwtVerifyMock.mockReset();
  jwtVerifyMock.mockResolvedValue({ payload: { sub: "user-1" } });
  storageRef.current.reset();
  process.env.APP_URL = "https://forge.example";
  process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID = "client_test_123";
  const conns = await import("@/server/core/auto-connections");
  conns.setConnectionVerifyOverridesForTests({});
});

afterEach(() => {
  delete process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Auth-path separation (bearer)
// ---------------------------------------------------------------------------

describe("auth-path separation — bearer connections routes", () => {
  it("POST /api/forge/auto/connections without a bearer → 401, nothing created", async () => {
    const res = await createViaRoute(connBody(), {});
    expect(res.status).toBe(401);
    expect(storageRef.current.state.connections.size).toBe(0);
  });

  it("GET outputs download without a bearer → 401", async () => {
    const { GET } = await import("@/app/api/forge/auto/runs/[id]/outputs/[...path]/route");
    const res = await GET(new Request("https://forge.example"), {
      params: Promise.resolve({ id: "run-1", path: ["a.txt"] })
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// CRUD (bearer)
// ---------------------------------------------------------------------------

describe("connections CRUD (bearer)", () => {
  it("POST 201: secret → SecretStore ref, never echoed; GET/list/PATCH clean too", async () => {
    const res = await createViaRoute();
    expect(res.status).toBe(201);
    const createdText = await res.text();
    expect(createdText).not.toContain("super-secret-value");
    const created = JSON.parse(createdText) as { id: string; secretRef: string; ownerId: string };
    expect(created.ownerId).toBe("user-1");
    expect(storageRef.current.state.secrets.map.get(created.secretRef)).toBe(SECRET);

    const byId = await import("@/app/api/forge/auto/connections/[id]/route");
    const getRes = await byId.GET(new Request("https://forge.example", { headers: AUTH }), {
      params: Promise.resolve({ id: created.id })
    });
    const list = await import("@/app/api/forge/auto/connections/route");
    const listRes = await list.GET(new Request("https://forge.example", { headers: AUTH }));
    const patchRes = await byId.PATCH(
      new Request("https://forge.example", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ secret: "rotated-secret-value" })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    for (const r of [getRes, listRes, patchRes]) {
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).not.toContain("super-secret-value");
      expect(text).not.toContain("rotated-secret-value");
    }
    // Rotation deleted the superseded ref.
    expect(storageRef.current.state.secrets.deletes).toContain(created.secretRef);
  });

  it("501 types on direct create: gdrive/dropbox (OAuth flow) + imap (coming soon)", async () => {
    for (const type of ["gdrive", "dropbox", "imap"]) {
      const res = await createViaRoute({ name: "x", type, config: {} });
      expect(res.status).toBe(501);
    }
    expect(storageRef.current.state.connections.size).toBe(0);
  });

  it("secret with unconfigured encryption key → 400", async () => {
    storageRef.current.state.secrets.configured = false;
    const res = await createViaRoute();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "Secret storage is not configured on this instance"
    );
  });

  it("cross-user GET/PATCH/DELETE → 404", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user-2" } });
    const byId = await import("@/app/api/forge/auto/connections/[id]/route");
    const getRes = await byId.GET(new Request("https://forge.example", { headers: AUTH }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(getRes.status).toBe(404);
    const delRes = await byId.DELETE(new Request("https://forge.example", { headers: AUTH }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(delRes.status).toBe(404);
    expect(storageRef.current.state.connections.size).toBe(1);
  });

  it("DELETE cleans the stored secret ref", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string; secretRef: string };
    const byId = await import("@/app/api/forge/auto/connections/[id]/route");
    const res = await byId.DELETE(new Request("https://forge.example", { headers: AUTH }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    expect(storageRef.current.state.secrets.deletes).toContain(created.secretRef);
    expect(storageRef.current.state.connections.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Verify probe (bearer)
// ---------------------------------------------------------------------------

describe("connection verify probe (bearer)", () => {
  it("s3 probe ok/error transitions via the injected client", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };
    const conns = await import("@/server/core/auto-connections");
    const verify = await import("@/app/api/forge/auto/connections/[id]/verify/route");

    conns.setConnectionVerifyOverridesForTests({ s3List: async () => {} });
    const okRes = await verify.POST(
      new Request("https://forge.example", { method: "POST", headers: AUTH }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(((await okRes.json()) as { status: string }).status).toBe("ok");

    conns.setConnectionVerifyOverridesForTests({
      s3List: async () => {
        throw new Error("NoSuchBucket");
      }
    });
    const errRes = await verify.POST(
      new Request("https://forge.example", { method: "POST", headers: AUTH }),
      { params: Promise.resolve({ id: created.id }) }
    );
    const body = (await errRes.json()) as { status: string; verifyError?: string };
    expect(body.status).toBe("error");
    expect(body.verifyError).toContain("NoSuchBucket");
  });

  it("webhook_out resolving to a private IP → SSRF-rejected, status error", async () => {
    const created = (await (
      await createViaRoute({ name: "hook", type: "webhook_out", config: { url: "https://internal.example/x" } })
    ).json()) as { id: string };
    const conns = await import("@/server/core/auto-connections");
    conns.setConnectionVerifyOverridesForTests({ resolver: async () => ["192.168.1.10"] });
    const verify = await import("@/app/api/forge/auto/connections/[id]/verify/route");
    const res = await verify.POST(
      new Request("https://forge.example", { method: "POST", headers: AUTH }),
      { params: Promise.resolve({ id: created.id }) }
    );
    const body = (await res.json()) as { status: string; verifyError?: string };
    expect(body.status).toBe("error");
    expect(body.verifyError).toContain("blocked");
  });
});

// ---------------------------------------------------------------------------
// Persisted-output downloads (bearer)
// ---------------------------------------------------------------------------

describe("run output downloads (bearer)", () => {
  const FUTURE = new Date(Date.now() + 60_000).toISOString();

  function seedRun() {
    storageRef.current.state.runs.push({
      id: "run-1",
      userId: "user-1",
      status: "succeeded",
      outputFiles: [
        {
          path: "reports/summary.md",
          sizeBytes: 12,
          storeKey: "auto-outputs/run-1/reports/summary.md",
          expiresAt: FUTURE
        }
      ]
    });
  }

  async function download(id: string, path: string[]): Promise<Response> {
    const { GET } = await import("@/app/api/forge/auto/runs/[id]/outputs/[...path]/route");
    return GET(new Request("https://forge.example", { headers: AUTH }), {
      params: Promise.resolve({ id, path })
    });
  }

  it("owner download → 302 with the presigned URL (fake store)", async () => {
    seedRun();
    const res = await download("run-1", ["reports", "summary.md"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://signed.example/auto-outputs/run-1/reports/summary.md?sig=test"
    );
  });

  it("owner-only: cross-user → 404; unknown path → 404", async () => {
    seedRun();
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user-2" } });
    expect((await download("run-1", ["reports", "summary.md"])).status).toBe(404);
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user-1" } });
    expect((await download("run-1", ["unknown.bin"])).status).toBe(404);
  });
});
