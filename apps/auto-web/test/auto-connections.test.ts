// Wave 3a APPS layer — Connections CRUD + verify probe + OAuth flow +
// persisted-output downloads (server/core/auto-connections.ts,
// server/core/auto-oauth.ts, /api/auto/connections* + /api/auto/runs/[id]/
// outputs/[...path]) — cookie auth.
//
// Mirrors the auto-events test conventions: cookie auth + storage are mocked;
// the MECHANISM (schema validation, SSRF guard, OAuth URL building/exchange)
// is the REAL auto-core implementation — only storage + network seams are
// injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// auto.ts transitively imports AuthKit; stub it so the module graph loads.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
  getSignInUrl: vi.fn(),
  handleAuth: vi.fn(),
  saveSession: vi.fn(),
  authkitMiddleware: vi.fn(() => vi.fn())
}));

// --- cookie auth mock ---------------------------------------------------------
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

// --- offline seams --------------------------------------------------------------
vi.mock("@/server/core/protected-kits", () => ({
  classifyKit: async () => ({ isProtected: false }),
  resolveProtectedSystemPrompt: async () => "PROTECTED_PROMPT",
  resolveProtectedSystemPromptViaService: async () => ({ systemPrompt: "X", pricing: "free", onlineOnly: false }),
  resolvePremiumRoyaltyCentsForRun: async () => 0,
  isPromptExtractionAttempt: () => false
}));
vi.mock("@/server/core/import-ops", () => ({
  createForwardingStore: () => ({ async get() { return null; }, async set() {}, async clear() {} })
}));
vi.mock("@/server/core/gateway", () => ({ getCreditLedger: () => ({}) }));
vi.mock("@/server/core/org-key-client", () => ({ resolveOrgApiKey: async () => undefined }));
vi.mock("@/server/core/org-usage-client", () => ({
  checkOrgUsage: async () => undefined,
  recordOrgUsage: async () => undefined
}));
vi.mock("@/server/store/user-settings", () => ({
  getUserSettingsStore: async () => ({ resolveProvider: async () => null })
}));
vi.mock("@/server/core/auto-byo", () => ({ getInferenceModePreference: async () => "auto" }));

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
      async createRun(input: Row) {
        const r = { id: `run-${runs.length}`, status: "queued", ...input };
        runs.push(r);
        return r;
      },
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

function connBody(over: Record<string, unknown> = {}) {
  return {
    name: "backup bucket",
    type: "s3",
    config: { bucket: "my-bucket", region: "us-east-1", prefix: "reports" },
    secret: SECRET,
    ...over
  };
}

async function createViaRoute(body: Record<string, unknown> = connBody()): Promise<Response> {
  const { POST } = await import("@/app/api/auto/connections/route");
  return POST(
    new Request("https://auto.example/api/auto/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

beforeEach(async () => {
  requireUserMock.mockReset();
  requireUserMock.mockResolvedValue({ id: "user-1", email: "u@example.com" });
  storageRef.current.reset();
  process.env.APP_URL = "https://auto.example";
  delete process.env.OAUTH_GDRIVE_CLIENT_ID;
  delete process.env.OAUTH_GDRIVE_CLIENT_SECRET;
  delete process.env.OAUTH_DROPBOX_CLIENT_ID;
  delete process.env.OAUTH_DROPBOX_CLIENT_SECRET;
  const conns = await import("@/server/core/auto-connections");
  conns.setConnectionVerifyOverridesForTests({});
  const oauth = await import("@/server/core/auto-oauth");
  oauth.setAutoOAuthOverridesForTests({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Connections CRUD (cookie)
// ---------------------------------------------------------------------------

describe("connections CRUD (cookie)", () => {
  it("POST creates an s3 connection (201): secret → SecretStore ref, NEVER echoed", async () => {
    const res = await createViaRoute();
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("super-secret-value");
    const created = JSON.parse(text) as Row;
    expect(created.type).toBe("s3");
    expect(created.status).toBe("unverified");
    expect(created.ownerId).toBe("user-1");
    // Server-side: the plaintext landed in the SecretStore behind the ref.
    const ref = created.secretRef as string;
    expect(ref).toBeTruthy();
    expect(storageRef.current.state.secrets.map.get(ref)).toBe(SECRET);
  });

  it("secret never appears in ANY response: create / get / list / patch", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };

    const byId = await import("@/app/api/auto/connections/[id]/route");
    const getRes = await byId.GET(new Request("https://auto.example"), {
      params: Promise.resolve({ id: created.id })
    });
    const list = await import("@/app/api/auto/connections/route");
    const listRes = await list.GET();
    const patchRes = await byId.PATCH(
      new Request("https://auto.example", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed", secret: "rotated-secret-value" })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );

    for (const res of [getRes, listRes, patchRes]) {
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("super-secret-value");
      expect(text).not.toContain("rotated-secret-value");
    }
  });

  it("POST with a secret while AUTO_SECRET_ENCRYPTION_KEY is unset → 400", async () => {
    storageRef.current.state.secrets.configured = false;
    const res = await createViaRoute();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("Secret storage is not configured on this instance");
    expect(storageRef.current.state.connections.size).toBe(0);
  });

  it("POST gdrive/dropbox → 501 use-the-OAuth-flow; imap → 501 coming soon", async () => {
    for (const type of ["gdrive", "dropbox"]) {
      const res = await createViaRoute({ name: "x", type, config: {} });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain("OAuth flow");
    }
    const res = await createViaRoute({ name: "x", type: "imap", config: {} });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { message: string }).message).toContain("coming soon");
    expect(storageRef.current.state.connections.size).toBe(0);
  });

  it("POST with secret-looking config keys → 400 (contracts refinement)", async () => {
    const res = await createViaRoute(connBody({ config: { bucket: "b", api_key: "leak" } }));
    expect(res.status).toBe(400);
  });

  it("GET list + GET [id] are ownership-scoped (cross-user → empty/404)", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };

    requireUserMock.mockResolvedValue({ id: "user-2", email: "e@example.com" });
    const list = await import("@/app/api/auto/connections/route");
    const listed = (await (await list.GET()).json()) as { connections: unknown[] };
    expect(listed.connections).toHaveLength(0);

    const byId = await import("@/app/api/auto/connections/[id]/route");
    const res = await byId.GET(new Request("https://auto.example"), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(404);
  });

  it("PATCH secret replacement stores a new ref and deletes the old one", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string; secretRef: string };
    const byId = await import("@/app/api/auto/connections/[id]/route");
    const res = await byId.PATCH(
      new Request("https://auto.example", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "rotated-secret-value" })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { secretRef: string };
    expect(updated.secretRef).not.toBe(created.secretRef);
    // Old ref deleted (recorded by the fake), new plaintext stored.
    expect(storageRef.current.state.secrets.deletes).toContain(created.secretRef);
    expect(storageRef.current.state.secrets.map.get(updated.secretRef)).toBe("rotated-secret-value");
  });

  it("PATCH with an invalid body (bad name) → 400; cross-user → 404", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };
    const byId = await import("@/app/api/auto/connections/[id]/route");
    const bad = await byId.PATCH(
      new Request("https://auto.example", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "" })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(bad.status).toBe(400);

    requireUserMock.mockResolvedValue({ id: "user-2" });
    const crossUser = await byId.PATCH(
      new Request("https://auto.example", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "hijack" })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(crossUser.status).toBe(404);
  });

  it("DELETE removes the connection AND its stored secret ref", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string; secretRef: string };
    const byId = await import("@/app/api/auto/connections/[id]/route");
    const res = await byId.DELETE(new Request("https://auto.example"), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    expect(storageRef.current.state.connections.size).toBe(0);
    expect(storageRef.current.state.secrets.deletes).toContain(created.secretRef);
  });

  it("unauthenticated → 401", async () => {
    requireUserMock.mockRejectedValue(new FakeUnauthorizedError());
    const res = await createViaRoute();
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Verify probe (cookie)
// ---------------------------------------------------------------------------

describe("connection verify probe (cookie)", () => {
  it("s3 probe ok → status ok (creds revealed server-side, probe sees bucket)", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };
    const probeCalls: Row[] = [];
    const conns = await import("@/server/core/auto-connections");
    conns.setConnectionVerifyOverridesForTests({
      s3List: async (args) => {
        probeCalls.push(args as unknown as Row);
      }
    });
    const verify = await import("@/app/api/auto/connections/[id]/verify/route");
    const res = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; lastUsedAt?: string; verifyError?: string };
    expect(body.status).toBe("ok");
    expect(body.verifyError).toBeUndefined();
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.bucket).toBe("my-bucket");
    expect(probeCalls[0]!.credentials).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-value"
    });
  });

  it("s3 probe failure → status error (+ detail, no secret leak)", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };
    const conns = await import("@/server/core/auto-connections");
    conns.setConnectionVerifyOverridesForTests({
      s3List: async () => {
        throw new Error("AccessDenied");
      }
    });
    const verify = await import("@/app/api/auto/connections/[id]/verify/route");
    const res = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value");
    const body = JSON.parse(text) as { status: string; verifyError?: string };
    expect(body.status).toBe("error");
    expect(body.verifyError).toContain("AccessDenied");
    expect(storageRef.current.state.connections.get(created.id)!.status).toBe("error");
  });

  it("webhook_out resolving to a private IP → SSRF-rejected, status error (nothing posted)", async () => {
    const created = (await (
      await createViaRoute({
        name: "hook",
        type: "webhook_out",
        config: { url: "https://internal.example/hook" }
      })
    ).json()) as { id: string };
    const conns = await import("@/server/core/auto-connections");
    conns.setConnectionVerifyOverridesForTests({ resolver: async () => ["10.0.0.5"] });
    const verify = await import("@/app/api/auto/connections/[id]/verify/route");
    const res = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; verifyError?: string };
    expect(body.status).toBe("error");
    expect(body.verifyError).toContain("blocked");
  });

  it("webhook_out resolving publicly → status ok", async () => {
    const created = (await (
      await createViaRoute({
        name: "hook",
        type: "slack_incoming",
        config: { url: "https://hooks.slack.com/services/T/B/x" }
      })
    ).json()) as { id: string };
    const conns = await import("@/server/core/auto-connections");
    conns.setConnectionVerifyOverridesForTests({ resolver: async () => ["93.184.216.34"] });
    const verify = await import("@/app/api/auto/connections/[id]/verify/route");
    const res = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("email format check: valid → ok, invalid → error", async () => {
    const good = (await (
      await createViaRoute({ name: "mail", type: "email", config: { to: ["a@example.com"] } })
    ).json()) as { id: string };
    const bad = (await (
      await createViaRoute({ name: "mail2", type: "email", config: { to: ["not-an-email"] } })
    ).json()) as { id: string };
    const verify = await import("@/app/api/auto/connections/[id]/verify/route");
    const okRes = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: good.id })
    });
    expect(((await okRes.json()) as { status: string }).status).toBe("ok");
    const errRes = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: bad.id })
    });
    expect(((await errRes.json()) as { status: string }).status).toBe("error");
  });

  it("cross-user verify → 404", async () => {
    const created = (await (await createViaRoute()).json()) as { id: string };
    requireUserMock.mockResolvedValue({ id: "user-2" });
    const verify = await import("@/app/api/auto/connections/[id]/verify/route");
    const res = await verify.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// OAuth flow (auto-web only)
// ---------------------------------------------------------------------------

describe("OAuth connection flow (gdrive/dropbox)", () => {
  it("start → 501 when the provider app credentials are unconfigured", async () => {
    const { GET } = await import("@/app/api/auto/connections/oauth/[provider]/start/route");
    const res = await GET(new Request("https://auto.example"), {
      params: Promise.resolve({ provider: "gdrive" })
    });
    expect(res.status).toBe(501);
  });

  it("start → 302 to the provider authorize URL (drive.file scope) + state cookie", async () => {
    process.env.OAUTH_GDRIVE_CLIENT_ID = "gid";
    process.env.OAUTH_GDRIVE_CLIENT_SECRET = "gsecret";
    const { GET } = await import("@/app/api/auto/connections/oauth/[provider]/start/route");
    const res = await GET(new Request("https://auto.example"), {
      params: Promise.resolve({ provider: "gdrive" })
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("gid");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auto.example/api/auto/connections/oauth/gdrive/callback"
    );
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(10);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`auto-oauth-state=${state}`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("Max-Age=600");
  });

  it("callback with a state mismatch → 400, no connection created", async () => {
    process.env.OAUTH_GDRIVE_CLIENT_ID = "gid";
    process.env.OAUTH_GDRIVE_CLIENT_SECRET = "gsecret";
    const { GET } = await import("@/app/api/auto/connections/oauth/[provider]/callback/route");
    const res = await GET(
      new Request("https://auto.example/api/auto/connections/oauth/gdrive/callback?code=c&state=evil", {
        headers: { cookie: "auto-oauth-state=expected" }
      }),
      { params: Promise.resolve({ provider: "gdrive" }) }
    );
    expect(res.status).toBe(400);
    expect(storageRef.current.state.connections.size).toBe(0);
  });

  it("happy callback: mocked exchange → connection created with secretRef; tokens never in the response", async () => {
    process.env.OAUTH_GDRIVE_CLIENT_ID = "gid";
    process.env.OAUTH_GDRIVE_CLIENT_SECRET = "gsecret";
    const oauth = await import("@/server/core/auto-oauth");
    const exchangeCalls: string[] = [];
    oauth.setAutoOAuthOverridesForTests({
      fetchImpl: async (url, init) => {
        exchangeCalls.push(`${url} ${init?.body ?? ""}`);
        return {
          status: 200,
          headers: { forEach: () => {} },
          text: async () =>
            JSON.stringify({ access_token: "at-123", refresh_token: "rt-456", expires_in: 3600 })
        };
      }
    });
    const { GET } = await import("@/app/api/auto/connections/oauth/[provider]/callback/route");
    const res = await GET(
      new Request("https://auto.example/api/auto/connections/oauth/gdrive/callback?code=authcode&state=st1", {
        headers: { cookie: "auto-oauth-state=st1" }
      }),
      { params: Promise.resolve({ provider: "gdrive" }) }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://auto.example/?connection=created");
    // The exchange hit Google's token endpoint with the code.
    expect(exchangeCalls[0]).toContain("https://oauth2.googleapis.com/token");
    expect(exchangeCalls[0]).toContain("code=authcode");
    // Connection: user-owned, type gdrive, status ok, token behind the ref.
    const conns = [...storageRef.current.state.connections.values()];
    expect(conns).toHaveLength(1);
    expect(conns[0]!.type).toBe("gdrive");
    expect(conns[0]!.ownerType).toBe("user");
    expect(conns[0]!.ownerId).toBe("user-1");
    expect(conns[0]!.status).toBe("ok");
    const ref = conns[0]!.secretRef as string;
    expect(storageRef.current.state.secrets.map.get(ref)).toContain("at-123");
    // Tokens never appear in the response (headers included).
    const headerDump = JSON.stringify([...res.headers.entries()]);
    expect(headerDump).not.toContain("at-123");
    expect(headerDump).not.toContain("rt-456");
  });

  it("failed exchange (provider 400) → 400, no connection", async () => {
    process.env.OAUTH_DROPBOX_CLIENT_ID = "did";
    process.env.OAUTH_DROPBOX_CLIENT_SECRET = "dsecret";
    const oauth = await import("@/server/core/auto-oauth");
    oauth.setAutoOAuthOverridesForTests({
      fetchImpl: async () => ({
        status: 400,
        headers: { forEach: () => {} },
        text: async () => JSON.stringify({ error: "invalid_grant" })
      })
    });
    const { GET } = await import("@/app/api/auto/connections/oauth/[provider]/callback/route");
    const res = await GET(
      new Request("https://auto.example/api/auto/connections/oauth/dropbox/callback?code=c&state=s", {
        headers: { cookie: "auto-oauth-state=s" }
      }),
      { params: Promise.resolve({ provider: "dropbox" }) }
    );
    expect(res.status).toBe(400);
    expect(storageRef.current.state.connections.size).toBe(0);
  });

  it("unknown provider → 400; unauthenticated start → 401", async () => {
    const { GET } = await import("@/app/api/auto/connections/oauth/[provider]/start/route");
    const bad = await GET(new Request("https://auto.example"), {
      params: Promise.resolve({ provider: "box" })
    });
    expect(bad.status).toBe(400);
    requireUserMock.mockRejectedValue(new FakeUnauthorizedError());
    const unauthed = await GET(new Request("https://auto.example"), {
      params: Promise.resolve({ provider: "gdrive" })
    });
    expect(unauthed.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Persisted-output downloads (cookie)
// ---------------------------------------------------------------------------

describe("run output downloads (cookie)", () => {
  const FUTURE = new Date(Date.now() + 60_000).toISOString();

  function seedRun(over: Row = {}) {
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
      ],
      ...over
    });
  }

  async function download(id: string, path: string[]): Promise<Response> {
    const { GET } = await import("@/app/api/auto/runs/[id]/outputs/[...path]/route");
    return GET(new Request("https://auto.example"), { params: Promise.resolve({ id, path }) });
  }

  it("owner download → 302 to the presigned URL", async () => {
    seedRun();
    const res = await download("run-1", ["reports", "summary.md"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://signed.example/auto-outputs/run-1/reports/summary.md?sig=test"
    );
  });

  it("cross-user → 404; unknown path → 404; expired entry → 404", async () => {
    seedRun();
    requireUserMock.mockResolvedValue({ id: "user-2" });
    expect((await download("run-1", ["reports", "summary.md"])).status).toBe(404);

    requireUserMock.mockResolvedValue({ id: "user-1" });
    expect((await download("run-1", ["nope.txt"])).status).toBe(404);

    storageRef.current.state.runs.length = 0;
    seedRun({
      outputFiles: [
        {
          path: "reports/summary.md",
          sizeBytes: 12,
          storeKey: "auto-outputs/run-1/reports/summary.md",
          expiresAt: new Date(Date.now() - 1000).toISOString()
        }
      ]
    });
    expect((await download("run-1", ["reports", "summary.md"])).status).toBe(404);
  });

  it("unauthenticated → 401", async () => {
    seedRun();
    requireUserMock.mockRejectedValue(new FakeUnauthorizedError());
    expect((await download("run-1", ["reports", "summary.md"])).status).toBe(401);
  });
});
