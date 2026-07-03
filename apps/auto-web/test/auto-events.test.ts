// Event-driven expansion — cookie CRUD routes + ingest + sweep wiring
// (server/core/auto-events.ts, server/core/event-ingest.ts, /api/auto/* +
// /api/hooks/auto/events/* + /api/internal/auto/sweep).
//
// Mirrors the auto-phase-c conventions: cookie auth + storage + provider are
// mocked; the ENGINE (consumeTriggerEvent gate chain, mapping evaluator,
// verifySourceToken) is the REAL auto-core implementation — only the storage
// adapters + dispatcher are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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

// --- in-memory storage (incl. the events bundle) -------------------------------
type Row = Record<string, unknown>;

function makeStorage() {
  const approvals: Row[] = [];
  const runs: Row[] = [];
  const triggers = new Map<string, Row>();
  const sources = new Map<string, Row>();
  const signingRefs = new Map<string, string>();
  const received = new Map<string, Row[]>();
  const fireLogs = new Map<string, Row[]>();
  const connections = new Map<string, Row>();
  const secrets = { configured: false, map: new Map<string, string>(), seq: 0 };
  let n = 0;

  const deps = {
    approvals: {
      async getApprovalForKit(userId: string) {
        return approvals.find((a) => a.userId === userId && a.revokedAt === null);
      },
      async createApproval(input: Row) {
        const a = { id: `appr-${approvals.length}`, revokedAt: null, ...input };
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
      },
      async requestCancel() {}
    },
    schedules: {
      // The legacy sweep runs first in /api/internal/auto/sweep — keep it a
      // functional no-op so the ADDITIVE trigger sweep is exercised in isolation.
      async listDueSchedules() {
        return [];
      }
    },
    webhooks: {},
    inputs: {},
    workspaces: {},
    events: {
      triggers: {
        async createTrigger(input: Row) {
          const t: Row = {
            id: `trig-${++n}`,
            ...input,
            rateLimit: input.rateLimit ?? { maxPerHour: 20 },
            enabled: input.enabled ?? true,
            cursor: null,
            circuit: { consecutiveFailures: 0, pausedAt: null },
            updatedAt: input.createdAt,
            fireCount: 0
          };
          triggers.set(t.id as string, t);
          return structuredClone(t);
        },
        async getTrigger(id: string) {
          const t = triggers.get(id);
          return t ? structuredClone(t) : undefined;
        },
        async listTriggersByUser(userId: string) {
          return [...triggers.values()].filter((t) => t.userId === userId).map((t) => structuredClone(t));
        },
        async listDue(type: string, nowISO: string) {
          return [...triggers.values()]
            .filter((t) => {
              const circuit = t.circuit as { pausedAt: string | null };
              if (t.type !== type || !t.enabled || circuit.pausedAt != null) return false;
              if (type === "schedule") return t.cursor == null || (t.cursor as string) <= nowISO;
              return true;
            })
            .map((t) => structuredClone(t));
        },
        async updateTrigger(id: string, patch: Row) {
          const t = triggers.get(id);
          if (!t) return undefined;
          for (const k of ["name", "approvalId", "model", "budgetCents", "filters", "mapping", "destinations", "rateLimit", "enabled", "config"]) {
            if (patch[k] !== undefined) t[k] = patch[k];
          }
          t.updatedAt = patch.updatedAt;
          return structuredClone(t);
        },
        async recordFire(id: string, result: Row) {
          const t = triggers.get(id);
          if (!t) return;
          t.lastFiredAt = result.lastFiredAt;
          t.lastRunId = result.lastRunId;
          t.fireCount = (t.fireCount as number) + 1;
        },
        async updateCursor(id: string, cursor: string | null) {
          const t = triggers.get(id);
          if (t) t.cursor = cursor;
        },
        async recordCircuitFailure(id: string) {
          const t = triggers.get(id);
          if (!t) return 0;
          const c = t.circuit as { consecutiveFailures: number };
          c.consecutiveFailures += 1;
          return c.consecutiveFailures;
        },
        async resetCircuit(id: string) {
          const t = triggers.get(id);
          if (t) t.circuit = { consecutiveFailures: 0, pausedAt: null };
        },
        async setCircuitPaused(id: string, pausedAt: string | null) {
          const t = triggers.get(id);
          if (t) (t.circuit as { pausedAt: string | null }).pausedAt = pausedAt;
        },
        async deleteTrigger(id: string) {
          triggers.delete(id);
        }
      },
      eventSources: {
        async createEventSource(input: Row) {
          const s: Row = {
            id: `src-${++n}`,
            ...input,
            hasSigningSecret: input.signingSecretRef ? true : input.hasSigningSecret,
            enabled: input.enabled ?? true,
            eventCount: 0
          };
          delete s.signingSecretRef;
          if (input.signingSecretRef) signingRefs.set(s.id as string, input.signingSecretRef as string);
          sources.set(s.id as string, s);
          return structuredClone(s);
        },
        async getEventSource(id: string) {
          const s = sources.get(id);
          return s ? structuredClone(s) : undefined;
        },
        async listEventSourcesByUser(userId: string) {
          return [...sources.values()].filter((s) => s.userId === userId).map((s) => structuredClone(s));
        },
        async findByTokenHash(hash: string) {
          const s = [...sources.values()].find((x) => x.tokenHash === hash);
          return s ? structuredClone(s) : undefined;
        },
        async updateEventSource(id: string, patch: Row) {
          const s = sources.get(id);
          if (!s) return undefined;
          if (patch.name !== undefined) s.name = patch.name;
          if (patch.enabled !== undefined) s.enabled = patch.enabled;
          if (patch.tokenHash !== undefined) s.tokenHash = patch.tokenHash;
          if (patch.signingSecretRef !== undefined) {
            if (patch.signingSecretRef === null) signingRefs.delete(id);
            else signingRefs.set(id, patch.signingSecretRef as string);
            s.hasSigningSecret = patch.signingSecretRef !== null;
          }
          return structuredClone(s);
        },
        async getSigningSecretRef(id: string) {
          return signingRefs.get(id);
        },
        async recordEvent(id: string, receivedAt: string) {
          const s = sources.get(id);
          if (!s) return;
          s.lastEventAt = receivedAt;
          s.eventCount = (s.eventCount as number) + 1;
        },
        async deleteEventSource(id: string) {
          sources.delete(id);
        }
      },
      receivedEvents: {
        async appendEvent(input: Row) {
          const e = { id: `evt-${++n}`, ...input };
          const buf = received.get(input.sourceId as string) ?? [];
          buf.push(e);
          received.set(input.sourceId as string, buf);
          return structuredClone(e);
        },
        async listEventsBySource(sourceId: string, limit = 50) {
          return [...(received.get(sourceId) ?? [])].reverse().slice(0, limit).map((e) => structuredClone(e));
        },
        async getEvent(eventId: string) {
          for (const buf of received.values()) {
            const found = buf.find((e) => e.id === eventId);
            if (found) return structuredClone(found);
          }
          return undefined;
        },
        async pruneEvents() {
          return 0;
        }
      },
      fireLogs: {
        async appendFireLog(input: Row) {
          const log = { id: `fire-${++n}`, runId: null, detail: null, ...input };
          const rows = fireLogs.get(input.triggerId as string) ?? [];
          rows.push(log);
          fireLogs.set(input.triggerId as string, rows);
          return structuredClone(log);
        },
        async listFireLogsByTrigger(triggerId: string, limit = 100) {
          return [...(fireLogs.get(triggerId) ?? [])].reverse().slice(0, limit).map((l) => structuredClone(l));
        }
      },
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
          secrets.map.delete(ref);
        }
      },
      connections: {
        async getConnection(id: string) {
          const c = connections.get(id);
          return c ? structuredClone(c) : undefined;
        },
        async listConnectionsByOwner(ownerType: string, ownerId: string) {
          return [...connections.values()].filter(
            (c) => c.ownerType === ownerType && c.ownerId === ownerId
          );
        },
        async createConnection(input: Row) {
          const c = { id: `conn-${++n}`, status: "unverified", ...input };
          connections.set(c.id as string, c);
          return structuredClone(c);
        },
        async updateConnection() {
          return undefined;
        },
        async setConnectionStatus() {},
        async deleteConnection(id: string) {
          connections.delete(id);
        }
      }
    }
  };

  /** In-place reset: server/core/auto.ts caches the deps OBJECT (singleton),
   *  so tests must clear the same instance rather than swap it out. */
  const reset = () => {
    approvals.length = 0;
    runs.length = 0;
    triggers.clear();
    sources.clear();
    signingRefs.clear();
    received.clear();
    fireLogs.clear();
    connections.clear();
    secrets.map.clear();
    secrets.configured = false;
    secrets.seq = 0;
  };

  return {
    deps,
    reset,
    state: { approvals, runs, triggers, sources, signingRefs, received, fireLogs, connections, secrets }
  };
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

const LOCAL_KIT = { source: "local", localKitId: "k" } as const;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function seedApproval(maxBudgetCents = 100_000) {
  storageRef.current.state.approvals.push({
    id: "appr-x",
    userId: "user-1",
    kitRef: LOCAL_KIT,
    toolAllowlist: ["read_file"],
    maxBudgetCents,
    networkPolicy: { mode: "deny_all" },
    createdAt: new Date().toISOString(),
    revokedAt: null
  });
}

function triggerBody(over: Record<string, unknown> = {}) {
  return {
    name: "deploy watcher",
    type: "event",
    config: { sourceId: "src-?", eventName: null },
    kitRef: LOCAL_KIT,
    approvalId: "appr-x",
    budgetCents: 50,
    mapping: { promptTemplate: "Handle {{action}}" },
    ...over
  };
}

async function createSourceViaRoute(): Promise<{ id: string; token: string }> {
  const { POST } = await import("@/app/api/auto/event-sources/route");
  const res = await POST(
    new Request("https://auto.example/api/auto/event-sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci" })
    })
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; token: string };
  return { id: body.id, token: body.token };
}

async function createTriggerViaRoute(sourceId: string, over: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/auto/triggers/route");
  const res = await POST(
    new Request("https://auto.example/api/auto/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(triggerBody({ config: { sourceId, eventName: null }, ...over }))
    })
  );
  return res;
}

async function ingest(sourceId: string, eventName: string, init: RequestInit): Promise<Response> {
  const { POST } = await import("@/app/api/hooks/auto/events/[sourceId]/[eventName]/route");
  return POST(new Request(`https://auto.example/api/hooks/auto/events/${sourceId}/${eventName}`, { method: "POST", ...init }), {
    params: Promise.resolve({ sourceId, eventName })
  });
}

beforeEach(async () => {
  requireUserMock.mockReset();
  requireUserMock.mockResolvedValue({ id: "user-1", email: "u@example.com" });
  storageRef.current.reset();
  process.env.APP_URL = "https://auto.example";
  // A generous L4 cap so multi-fire tests exercise the fan-out, not the cap.
  process.env.AUTO_MAX_CONCURRENT_RUNS = "100";
  delete process.env.GATEWAY_INTERNAL_BASE_URL;
  delete process.env.GATEWAY_SERVICE_KEY;
  const auto = await import("@/server/core/auto");
  auto.setAutoDispatcher(async () => {});
  const ingestMod = await import("@/server/core/event-ingest");
  ingestMod.setEventIngestOverridesForTests({});
  const eventsMod = await import("@/server/core/auto-events");
  eventsMod.setTriggerPollOverridesForTests({});
});

afterEach(() => {
  delete process.env.AUTO_MAX_CONCURRENT_RUNS;
  delete process.env.AUTO_WORKER_SERVICE_KEY;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Trigger CRUD (cookie)
// ---------------------------------------------------------------------------

describe("trigger CRUD (cookie)", () => {
  it("POST creates an event trigger (201) under the approval gate", async () => {
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    const res = await createTriggerViaRoute(sourceId);
    expect(res.status).toBe(201);
    const trigger = (await res.json()) as Record<string, unknown>;
    expect(trigger.type).toBe("event");
    expect(trigger.userId).toBe("user-1");
    expect(trigger.enabled).toBe(true);
    expect((trigger.circuit as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
  });

  it("POST without a standing approval → 403 approval_denied", async () => {
    const { id: sourceId } = await createSourceViaRoute();
    const res = await createTriggerViaRoute(sourceId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("approval_denied");
  });

  it("POST with a budget over the approval ceiling → 403", async () => {
    seedApproval(10);
    const { id: sourceId } = await createSourceViaRoute();
    const res = await createTriggerViaRoute(sourceId, { budgetCents: 999 });
    expect(res.status).toBe(403);
  });

  it("POST with an invalid body (missing mapping) → 400", async () => {
    seedApproval();
    const { POST } = await import("@/app/api/auto/triggers/route");
    const body = triggerBody() as Record<string, unknown>;
    delete body.mapping;
    const res = await POST(
      new Request("https://auto.example/api/auto/triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    );
    expect(res.status).toBe(400);
  });

  it("POST with a foreign sourceId → 400", async () => {
    seedApproval();
    const res = await createTriggerViaRoute("src-not-yours");
    expect(res.status).toBe(400);
  });

  it("schedule trigger: cursor initialized to the first cron fire (not immediately due)", async () => {
    seedApproval();
    const { POST } = await import("@/app/api/auto/triggers/route");
    const res = await POST(
      new Request("https://auto.example/api/auto/triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(triggerBody({ type: "schedule", config: { cron: "*/5 * * * *" } }))
      })
    );
    expect(res.status).toBe(201);
    const trigger = (await res.json()) as { id: string; cursor: string | null };
    expect(trigger.cursor).toBeTruthy();
    expect(Date.parse(trigger.cursor as string)).toBeGreaterThan(Date.now() - 1000);
  });

  it("GET list + GET [id] are ownership-scoped (cross-user → empty/404)", async () => {
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };

    requireUserMock.mockResolvedValue({ id: "user-2", email: "e@example.com" });
    const { GET } = await import("@/app/api/auto/triggers/route");
    const list = (await (await GET()).json()) as { triggers: unknown[] };
    expect(list.triggers).toHaveLength(0);

    const byId = await import("@/app/api/auto/triggers/[id]/route");
    const res = await byId.GET(new Request("https://auto.example"), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(404);
  });

  it("PATCH with a config that does not match the trigger's type → 400 (type immutable)", async () => {
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };
    const byId = await import("@/app/api/auto/triggers/[id]/route");
    const res = await byId.PATCH(
      new Request("https://auto.example", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { cron: "*/5 * * * *" } })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(res.status).toBe(400);
  });

  it("PATCH { enabled: true } RESETS the circuit breaker (the UI's Resume)", async () => {
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };
    // Simulate a paused circuit.
    const t = storageRef.current.state.triggers.get(created.id)!;
    t.circuit = { consecutiveFailures: 10, pausedAt: new Date().toISOString() };
    t.enabled = true; // still enabled — Resume must reset regardless

    const byId = await import("@/app/api/auto/triggers/[id]/route");
    const res = await byId.PATCH(
      new Request("https://auto.example", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(res.status).toBe(200);
    const after = storageRef.current.state.triggers.get(created.id)!;
    expect(after.circuit).toEqual({ consecutiveFailures: 0, pausedAt: null });
  });

  it("DELETE removes the trigger (ownership-checked)", async () => {
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };
    const byId = await import("@/app/api/auto/triggers/[id]/route");
    const res = await byId.DELETE(new Request("https://auto.example", { method: "DELETE" }), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    expect(storageRef.current.state.triggers.has(created.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event sources (one-time token semantics)
// ---------------------------------------------------------------------------

describe("event sources (cookie)", () => {
  it("create returns the plaintext token ONCE; only its hash is stored", async () => {
    const { id, token } = await createSourceViaRoute();
    const stored = storageRef.current.state.sources.get(id)!;
    expect(stored.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("get/list responses NEVER carry token or tokenHash", async () => {
    const { id } = await createSourceViaRoute();
    const listRoute = await import("@/app/api/auto/event-sources/route");
    const list = (await (await listRoute.GET()).json()) as { sources: Record<string, unknown>[] };
    expect(list.sources).toHaveLength(1);
    expect(list.sources[0]).not.toHaveProperty("token");
    expect(list.sources[0]).not.toHaveProperty("tokenHash");
    expect(list.sources[0].ingestUrl).toBe(`https://auto.example/api/hooks/auto/events/${id}`);

    const byId = await import("@/app/api/auto/event-sources/[id]/route");
    const got = (await (
      await byId.GET(new Request("https://auto.example"), { params: Promise.resolve({ id }) })
    ).json()) as Record<string, unknown>;
    expect(got).not.toHaveProperty("token");
    expect(got).not.toHaveProperty("tokenHash");
  });

  it("rotate-token issues a NEW one-time token; the old one stops authenticating", async () => {
    const { id, token } = await createSourceViaRoute();
    const rotate = await import("@/app/api/auto/event-sources/[id]/rotate-token/route");
    const res = await rotate.POST(new Request("https://auto.example", { method: "POST" }), {
      params: Promise.resolve({ id })
    });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as { token: string };
    expect(rotated.token).not.toBe(token);
    expect(storageRef.current.state.sources.get(id)!.tokenHash).toBe(sha256(rotated.token));

    // Old token → uniform 401 at ingest; new token → 202.
    const oldRes = await ingest(id, "ping", { headers: { "x-auto-event-token": token }, body: "{}" });
    expect(oldRes.status).toBe(401);
    const newRes = await ingest(id, "ping", { headers: { "x-auto-event-token": rotated.token }, body: "{}" });
    expect(newRes.status).toBe(202);
  });

  it("signingSecret without configured secret storage → clear 400", async () => {
    storageRef.current.state.secrets.configured = false;
    const { POST } = await import("@/app/api/auto/event-sources/route");
    const res = await POST(
      new Request("https://auto.example/api/auto/event-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "gh", kind: "provider", provider: "github", signingSecret: "hush" })
      })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/not configured/i);
  });

  it("signingSecret with configured storage → hasSigningSecret true; secret never echoed", async () => {
    storageRef.current.state.secrets.configured = true;
    const { POST } = await import("@/app/api/auto/event-sources/route");
    const res = await POST(
      new Request("https://auto.example/api/auto/event-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "gh", kind: "provider", provider: "github", signingSecret: "hush" })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hasSigningSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("hush");
    expect(JSON.stringify(body)).not.toContain("sref-");
    // Stored encrypted-recoverable behind the ref.
    const ref = storageRef.current.state.signingRefs.get(body.id as string)!;
    expect(storageRef.current.state.secrets.map.get(ref)).toBe("hush");
  });
});

// ---------------------------------------------------------------------------
// Ingest + inspector + replay + test-fire + fire-logs
// ---------------------------------------------------------------------------

describe("ingest → fan-out → inspector (cookie surfaces)", () => {
  it("valid token → 202, event stored, subscribed trigger creates a run with triggerId", async () => {
    seedApproval();
    const { id: sourceId, token } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };

    const res = await ingest(sourceId, "deploy", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ action: "released" })
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; eventId: string };
    expect(body.accepted).toBe(true);
    expect(body.eventId).toBeTruthy();

    // Run created through the REAL startRun path with trigger provenance.
    const run = storageRef.current.state.runs[0]!;
    expect(run.triggerId).toBe(created.id);
    expect(run.trigger).toBe("webhook");
    expect((run.input as { prompt: string }).prompt).toBe("Handle released");
    // S1: the payload travels as an attached FILE, never free prompt text.
    expect((run.input as { files: { path: string }[] }).files[0]!.path).toBe("event.json");

    // Inspector shows the event; source counters stamped.
    const eventsRoute = await import("@/app/api/auto/event-sources/[id]/events/route");
    const listed = (await (
      await eventsRoute.GET(new Request("https://auto.example"), { params: Promise.resolve({ id: sourceId }) })
    ).json()) as { events: { name: string }[] };
    expect(listed.events).toHaveLength(1);
    expect(listed.events[0]!.name).toBe("deploy");
    expect(storageRef.current.state.sources.get(sourceId)!.eventCount).toBe(1);
  });

  it("event is STORED even when every subscribed trigger filters it out", async () => {
    seedApproval();
    const { id: sourceId, token } = await createSourceViaRoute();
    const created = (await (
      await createTriggerViaRoute(sourceId, { filters: [{ path: "action", op: "eq", value: "opened" }] })
    ).json()) as { id: string };

    const res = await ingest(sourceId, "deploy", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ action: "closed" })
    });
    expect(res.status).toBe(202);
    expect(storageRef.current.state.runs).toHaveLength(0);
    // The event still entered the ring buffer; the fire log records "filtered".
    expect(storageRef.current.state.received.get(sourceId)).toHaveLength(1);
    const logs = storageRef.current.state.fireLogs.get(created.id)!;
    expect(logs[0]!.outcome).toBe("filtered");
  });

  it("eventName filtering: a trigger bound to another event name does not fire", async () => {
    seedApproval();
    const { id: sourceId, token } = await createSourceViaRoute();
    await createTriggerViaRoute(sourceId, { config: { sourceId, eventName: "other" } });
    const res = await ingest(sourceId, "deploy", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ a: 1 })
    });
    expect(res.status).toBe(202);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });

  it("test-fire runs the REAL consume path and creates a run", async () => {
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };

    const testFire = await import("@/app/api/auto/triggers/[id]/test-fire/route");
    const res = await testFire.POST(
      new Request("https://auto.example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sampleEvent: { action: "sampled" } })
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fireLog: { outcome: string }; runId?: string };
    expect(body.fireLog.outcome).toBe("run_created");
    expect(body.runId).toBeTruthy();
    expect(storageRef.current.state.runs[0]!.triggerId).toBe(created.id);

    // Cross-user test-fire → 404 (ownership).
    requireUserMock.mockResolvedValue({ id: "user-2", email: "e@example.com" });
    const crossRes = await testFire.POST(
      new Request("https://auto.example", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(crossRes.status).toBe(404);
  });

  it("replay re-consumes a stored event (owner-only)", async () => {
    seedApproval();
    const { id: sourceId, token } = await createSourceViaRoute();
    await createTriggerViaRoute(sourceId);
    const ingestRes = await ingest(sourceId, "deploy", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ action: "v1" })
    });
    const { eventId } = (await ingestRes.json()) as { eventId: string };
    expect(storageRef.current.state.runs).toHaveLength(1);

    const replay = await import("@/app/api/auto/event-sources/[id]/replay/route");
    const res = await replay.POST(
      new Request("https://auto.example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId })
      }),
      { params: Promise.resolve({ id: sourceId }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: { fireLog: { outcome: string } }[] };
    expect(body.ok).toBe(true);
    expect(body.results[0]!.fireLog.outcome).toBe("run_created");
    expect(storageRef.current.state.runs).toHaveLength(2);

    // Owner-only: another user gets a 404 (source not theirs).
    requireUserMock.mockResolvedValue({ id: "user-2", email: "e@example.com" });
    const crossRes = await replay.POST(
      new Request("https://auto.example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId })
      }),
      { params: Promise.resolve({ id: sourceId }) }
    );
    expect(crossRes.status).toBe(404);
  });

  it("fire-logs lists recent rows (ownership-checked)", async () => {
    seedApproval();
    const { id: sourceId, token } = await createSourceViaRoute();
    const created = (await (await createTriggerViaRoute(sourceId)).json()) as { id: string };
    await ingest(sourceId, "deploy", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ a: 1 })
    });

    const fireLogs = await import("@/app/api/auto/triggers/[id]/fire-logs/route");
    const res = await fireLogs.GET(new Request("https://auto.example"), {
      params: Promise.resolve({ id: created.id })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fireLogs: { outcome: string }[] };
    expect(body.fireLogs).toHaveLength(1);
    expect(body.fireLogs[0]!.outcome).toBe("run_created");

    requireUserMock.mockResolvedValue({ id: "user-2", email: "e@example.com" });
    const crossRes = await fireLogs.GET(new Request("https://auto.example"), {
      params: Promise.resolve({ id: created.id })
    });
    expect(crossRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Sweep extension (additive next to the legacy schedule sweep)
// ---------------------------------------------------------------------------

describe("sweep extension — schedule-TYPE triggers", () => {
  it("runs due schedule triggers after the legacy sweep (isolated, additive)", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = "sweep-key";
    seedApproval();
    const { id: sourceId } = await createSourceViaRoute();
    // A schedule trigger, forced DUE by rewinding its cursor.
    const { POST: createRoute } = await import("@/app/api/auto/triggers/route");
    const created = (await (
      await createRoute(
        new Request("https://auto.example/api/auto/triggers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            triggerBody({ type: "schedule", config: { cron: "*/5 * * * *" }, mapping: { promptTemplate: "tick" } })
          )
        })
      )
    ).json()) as { id: string };
    storageRef.current.state.triggers.get(created.id)!.cursor = "2020-01-01T00:00:00.000Z";
    void sourceId;

    const sweep = await import("@/app/api/internal/auto/sweep/route");
    const res = await sweep.POST(
      new Request("https://auto.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": "sweep-key" }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      triggerSweep: { processed: number; dispatched: number };
    };
    // Legacy sweep untouched (no legacy schedules seeded).
    expect(body.processed).toBe(0);
    // The trigger sweep fired our due schedule trigger.
    expect(body.triggerSweep.processed).toBe(1);
    expect(body.triggerSweep.dispatched).toBe(1);
    const run = storageRef.current.state.runs[0]!;
    expect(run.trigger).toBe("schedule");
    expect(run.triggerId).toBe(created.id);
    // Double-fire guard: the cursor advanced past now BEFORE dispatch.
    const cursor = storageRef.current.state.triggers.get(created.id)!.cursor as string;
    expect(Date.parse(cursor)).toBeGreaterThan(Date.now() - 60_000);
  });
});

// ---------------------------------------------------------------------------
// Wave 3b — fan-out cap + the generalized poll sweep (watch/rss/run_completed)
// ---------------------------------------------------------------------------

describe("fan-out — one event to ALL matching triggers (capped)", () => {
  it("delivers one ingested event to every subscribed trigger, capped at MAX_SUBSCRIPTIONS_PER_EVENT", async () => {
    const { MAX_SUBSCRIPTIONS_PER_EVENT } = await import("@/server/core/auto-events");
    seedApproval();
    const { id: sourceId, token } = await createSourceViaRoute();
    // Two more subscriptions than the cap.
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_EVENT + 2; i++) {
      const res = await createTriggerViaRoute(sourceId, { name: `sub-${i}` });
      expect(res.status).toBe(201);
    }
    const res = await ingest(sourceId, "deploy", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ action: "released" })
    });
    expect(res.status).toBe(202);
    // Exactly the cap fired — each through its OWN fully-gated consume.
    expect(storageRef.current.state.runs).toHaveLength(MAX_SUBSCRIPTIONS_PER_EVENT);
    const firedTriggers = new Set(storageRef.current.state.runs.map((r) => r.triggerId));
    expect(firedTriggers.size).toBe(MAX_SUBSCRIPTIONS_PER_EVENT);
  });
});

describe("poll sweep — Wave 3b (watch / rss / run_completed)", () => {
  const SWEEP_KEY = "sweep-key";

  async function callSweep() {
    const sweep = await import("@/app/api/internal/auto/sweep/route");
    const res = await sweep.POST(
      new Request("https://auto.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": SWEEP_KEY }
      })
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      pollSweep: {
        watch: { processed: number; dispatched: number; skipped: number; errors: unknown[] };
        rss: { processed: number; dispatched: number; skipped: number; errors: unknown[] };
        runCompleted: { processed: number; dispatched: number; skipped: number; errors: unknown[] };
      };
    };
  }

  function rewindPollCursor(triggerId: string) {
    const trigger = storageRef.current.state.triggers.get(triggerId)!;
    const cursor = JSON.parse(trigger.cursor as string) as { polledAt: string };
    cursor.polledAt = "2020-01-01T00:00:00.000Z";
    trigger.cursor = JSON.stringify(cursor);
  }

  it("watch: baseline sweep, then a new object fires a REAL run through startRun (S2: creds revealed server-side only)", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SWEEP_KEY;
    seedApproval();
    // An s3 connection whose credential lives in the (fake) SecretStore.
    storageRef.current.state.secrets.map.set(
      "sref-s3",
      JSON.stringify({ accessKeyId: "AK", secretAccessKey: "SK" })
    );
    storageRef.current.state.connections.set("conn-s3", {
      id: "conn-s3",
      ownerType: "user",
      ownerId: "user-1",
      name: "dropbox bucket",
      type: "s3",
      config: { bucket: "drop" },
      secretRef: "sref-s3",
      status: "ok",
      createdAt: new Date().toISOString()
    });
    const { POST: createRoute } = await import("@/app/api/auto/triggers/route");
    const created = (await (
      await createRoute(
        new Request("https://auto.example/api/auto/triggers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            triggerBody({
              type: "watch",
              config: { connectionId: "conn-s3", intervalMinutes: 1 },
              mapping: { promptTemplate: "New file {{key}}" }
            })
          )
        })
      )
    ).json()) as { id: string };

    const listing: { key: string; size: number; etag: string; lastModified: string }[] = [];
    const revealed: string[] = [];
    const eventsMod = await import("@/server/core/auto-events");
    eventsMod.setTriggerPollOverridesForTests({
      s3List: async (args) => {
        revealed.push(args.credentials.accessKeyId);
        return [...listing];
      }
    });

    // Sweep 1: BASELINE (pre-populated buckets never storm — here it's empty).
    const first = await callSweep();
    expect(first.pollSweep.watch.processed).toBe(1);
    expect(first.pollSweep.watch.dispatched).toBe(0);
    expect(revealed).toEqual(["AK"]); // SecretStore reveal happened server-side

    // A file lands; the trigger becomes due again (rewind the interval clock).
    listing.push({
      key: "inbox/report.csv",
      size: 42,
      etag: "e-1",
      lastModified: new Date().toISOString()
    });
    rewindPollCursor(created.id);

    const second = await callSweep();
    expect(second.pollSweep.watch.dispatched).toBe(1);
    const run = storageRef.current.state.runs[0]!;
    expect(run.triggerId).toBe(created.id);
    expect((run.input as { prompt: string }).prompt).toBe("New file inbox/report.csv");
    // S1: metadata payload rides as the attached file, never free prompt text.
    const files = (run.input as { files: { path: string; content: string }[] }).files;
    expect(files[0]!.path).toBe("event.json");
    expect(JSON.parse(files[0]!.content)).toMatchObject({ key: "inbox/report.csv", eventName: "object_created" });
  });

  it("run_completed: a newly-terminal run chains a REAL run; chainDepth=1 persists onto run.input.event", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SWEEP_KEY;
    seedApproval();
    const { POST: createRoute } = await import("@/app/api/auto/triggers/route");
    const created = (await (
      await createRoute(
        new Request("https://auto.example/api/auto/triggers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            triggerBody({
              type: "run_completed",
              config: {},
              mapping: { promptTemplate: "Chain off {{runId}} ({{status}})" }
            })
          )
        })
      )
    ).json()) as { id: string };

    // Sweep 1: BASELINE — the poller acknowledges "now"; nothing fires.
    const first = await callSweep();
    expect(first.pollSweep.runCompleted.processed).toBe(1);
    expect(storageRef.current.state.runs).toHaveLength(0);

    // A run reaches terminal AFTER the baseline mark.
    storageRef.current.state.runs.push({
      id: "upstream-run",
      userId: "user-1",
      kitRef: LOCAL_KIT,
      status: "succeeded",
      finishedAt: new Date(Date.now() + 60_000).toISOString(),
      input: { prompt: "original work" },
      result: { output: "Upstream summary." }
    });

    const second = await callSweep();
    expect(second.pollSweep.runCompleted.dispatched).toBe(1);
    const chained = storageRef.current.state.runs.find((r) => r.triggerId === created.id)!;
    expect(chained).toBeTruthy();
    expect((chained.input as { prompt: string }).prompt).toBe("Chain off upstream-run (succeeded)");
    // The loop-guard carrier: depth 1 persisted through the REAL startRun path.
    expect((chained.input as { event: unknown }).event).toEqual({
      name: "run_completed",
      chainDepth: 1
    });
    const payload = JSON.parse(
      (chained.input as { files: { content: string }[] }).files[0]!.content
    ) as { chainDepth: number; runId: string; summary: string };
    expect(payload).toMatchObject({ runId: "upstream-run", chainDepth: 1, summary: "Upstream summary." });

    // Sweep 3: no dupe — but note the CHAINED run itself is now terminal-free
    // (queued), so nothing new fires either.
    const third = await callSweep();
    expect(third.pollSweep.runCompleted.dispatched).toBe(0);
  });

  it("error isolation: a broken watch connection + an SSRF-blocked feed never kill the sweep or each other", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SWEEP_KEY;
    seedApproval();
    const { POST: createRoute } = await import("@/app/api/auto/triggers/route");
    const mk = async (body: Record<string, unknown>) =>
      (await (
        await createRoute(
          new Request("https://auto.example/api/auto/triggers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(triggerBody(body))
          })
        )
      ).json()) as { id: string };

    const watch = await mk({
      type: "watch",
      config: { connectionId: "does-not-exist" },
      mapping: { promptTemplate: "w {{key}}" }
    });
    const rss = await mk({
      type: "rss",
      config: { feedUrl: "https://internal.example.com/feed.xml" },
      mapping: { promptTemplate: "r {{title}}" }
    });
    await mk({ type: "run_completed", config: {}, mapping: { promptTemplate: "c {{runId}}" } });

    const eventsMod = await import("@/server/core/auto-events");
    const fetchCalls: string[] = [];
    eventsMod.setTriggerPollOverridesForTests({
      resolver: async () => ["10.0.0.8"], // private → SSRF-rejected
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return { status: 200, headers: { forEach: () => {} }, text: async () => "<rss/>" };
      }
    });

    const body = await callSweep();
    // Both failures isolated per trigger; the endpoint stayed 200.
    expect(body.pollSweep.watch.errors).toHaveLength(1);
    expect(body.pollSweep.rss.errors).toHaveLength(1);
    expect(fetchCalls).toHaveLength(0); // the SSRF guard fired BEFORE any request
    // run_completed still baselined despite the sibling failures.
    expect(body.pollSweep.runCompleted.processed).toBe(1);
    expect(storageRef.current.state.runs).toHaveLength(0);
    // Each failure produced an "error" fire-log row + a circuit count.
    expect(storageRef.current.state.fireLogs.get(watch.id)![0]!.outcome).toBe("error");
    expect(storageRef.current.state.fireLogs.get(rss.id)![0]!.outcome).toBe("error");
    expect(
      (storageRef.current.state.triggers.get(watch.id)!.circuit as { consecutiveFailures: number })
        .consecutiveFailures
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Wave 4 — messaging control-plane handshakes (signature-verified, never events)
// ---------------------------------------------------------------------------

describe("messaging control-plane — provider handshakes", () => {
  const { createHmac, generateKeyPairSync, sign: cryptoSign } = require("node:crypto") as
    typeof import("node:crypto");

  async function createProviderSource(provider: string, signingSecret: string): Promise<string> {
    storageRef.current.state.secrets.configured = true;
    const { POST } = await import("@/app/api/auto/event-sources/route");
    const res = await POST(
      new Request("https://auto.example/api/auto/event-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${provider}-src`, kind: "provider", provider, signingSecret })
      })
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("slack url_verification → 200 challenge echo; NO event stored, NO run", async () => {
    const secret = "slack-hush";
    const id = await createProviderSource("slack", secret);
    const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`, "utf8").digest("hex");
    const res = await ingest(id, "message", {
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
      body
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { challenge: string }).challenge).toBe("chal-123");
    expect(storageRef.current.state.received.get(id) ?? []).toHaveLength(0);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });

  it("slack url_verification with a BAD signature → uniform 401 (no challenge echo)", async () => {
    const id = await createProviderSource("slack", "slack-hush");
    const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await ingest(id, "message", {
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" },
      body
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("chal-123");
  });

  it("discord PING (type 1) → PONG (type 1); NO event stored", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubHex = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
      .subarray(-32)
      .toString("hex");
    const id = await createProviderSource("discord", pubHex);
    const body = JSON.stringify({ type: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = cryptoSign(null, Buffer.from(ts + body, "utf8"), privateKey).toString("hex");
    const res = await ingest(id, "interaction", {
      headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts },
      body
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { type: number }).type).toBe(1);
    expect(storageRef.current.state.received.get(id) ?? []).toHaveLength(0);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });

  it("telegram: wrong secret_token → uniform 401; correct → foreign callback acked, no event", async () => {
    const id = await createProviderSource("telegram", "tg-hush");
    const cb = JSON.stringify({ callback_query: { id: "cq-1", data: "not-ours" } });
    const bad = await ingest(id, "message", {
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      body: cb
    });
    expect(bad.status).toBe(401);
    const ok = await ingest(id, "message", {
      headers: { "x-telegram-bot-api-secret-token": "tg-hush" },
      body: cb
    });
    expect(ok.status).toBe(200);
    expect(storageRef.current.state.received.get(id) ?? []).toHaveLength(0);
    expect(storageRef.current.state.runs).toHaveLength(0);
  });
});
