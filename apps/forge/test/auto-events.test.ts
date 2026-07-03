// Event-driven expansion — INGEST SECURITY + fan-out/concurrency caps + bearer
// auth separation (server/core/auto-events.ts, server/core/event-ingest.ts,
// /api/hooks/auto/events/*, /api/forge/auto/*, /api/internal/auto/sweep).
//
// Mirrors test/auto-phase-c.test.ts: jose + storage + provider are mocked; the
// ENGINE (consumeTriggerEvent, signature verifiers, verifySourceToken) is the
// REAL auto-core implementation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

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
  const secrets = { configured: true, map: new Map<string, string>(), seq: 0 };
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
      }
    }
  };

  const reset = () => {
    approvals.length = 0;
    runs.length = 0;
    triggers.clear();
    sources.clear();
    signingRefs.clear();
    received.clear();
    fireLogs.clear();
    secrets.map.clear();
    secrets.configured = true;
    secrets.seq = 0;
  };

  return { deps, reset, state: { approvals, runs, triggers, sources, signingRefs, received, fireLogs, secrets } };
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

/** Create a source through the composition module (bearer plumbing not under
 *  test here) and return { id, token }. */
async function makeSource(over: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  const ev = await import("@/server/core/auto-events");
  const created = await ev.createEventSource("user-1", { name: "src", ...over });
  return { id: created.id, token: created.token };
}

async function makeTrigger(sourceId: string, over: Record<string, unknown> = {}) {
  const ev = await import("@/server/core/auto-events");
  return ev.createTrigger("user-1", {
    name: "t",
    type: "event",
    config: { sourceId, eventName: null },
    kitRef: LOCAL_KIT,
    approvalId: "appr-x",
    budgetCents: 50,
    mapping: { promptTemplate: "Handle {{action}}" },
    ...over
  });
}

async function ingest(sourceId: string, eventName: string, init: RequestInit): Promise<Response> {
  const { POST } = await import("@/app/api/hooks/auto/events/[sourceId]/[eventName]/route");
  return POST(new Request(`https://forge.example/api/hooks/auto/events/${sourceId}/${eventName}`, { method: "POST", ...init }), {
    params: Promise.resolve({ sourceId, eventName })
  });
}

beforeEach(async () => {
  jwtVerifyMock.mockReset();
  storageRef.current.reset();
  process.env.APP_URL = "https://forge.example";
  process.env.AUTO_MAX_CONCURRENT_RUNS = "100";
  delete process.env.GATEWAY_INTERNAL_BASE_URL;
  delete process.env.GATEWAY_SERVICE_KEY;
  const auto = await import("@/server/core/auto");
  auto.setAutoDispatcher(async () => {});
  const ingestMod = await import("@/server/core/event-ingest");
  ingestMod.setEventIngestOverridesForTests({});
});

afterEach(() => {
  delete process.env.AUTO_MAX_CONCURRENT_RUNS;
  delete process.env.AUTO_WORKER_SERVICE_KEY;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Auth-path separation (bearer CRUD)
// ---------------------------------------------------------------------------

describe("auth-path separation — bearer trigger/event-source CRUD", () => {
  it("POST /api/forge/auto/triggers without a bearer → 401, nothing created", async () => {
    const { POST } = await import("@/app/api/forge/auto/triggers/route");
    const res = await POST(
      new Request("https://forge.example/api/forge/auto/triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "t" })
      })
    );
    expect(res.status).toBe(401);
    expect(storageRef.current.state.triggers.size).toBe(0);
  });

  it("POST /api/forge/auto/event-sources without a bearer → 401, nothing created", async () => {
    const { POST } = await import("@/app/api/forge/auto/event-sources/route");
    const res = await POST(
      new Request("https://forge.example/api/forge/auto/event-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "s" })
      })
    );
    expect(res.status).toBe(401);
    expect(storageRef.current.state.sources.size).toBe(0);
  });

  it("POST /api/forge/auto/connections without a bearer → 401, nothing created", async () => {
    const { POST } = await import("@/app/api/forge/auto/connections/route");
    const res = await POST(
      new Request("https://forge.example/api/forge/auto/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "c", type: "s3", config: {} })
      })
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/forge/auto/runs/[id]/outputs/[...path] without a bearer → 401", async () => {
    const { GET } = await import("@/app/api/forge/auto/runs/[id]/outputs/[...path]/route");
    const res = await GET(new Request("https://forge.example/api/forge/auto/runs/r1/outputs/out.txt"), {
      params: Promise.resolve({ id: "r1", path: ["out.txt"] })
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Ingest security matrix
// ---------------------------------------------------------------------------

describe("ingest security — uniform terse 401s", () => {
  it("unknown source id → 401 (indistinguishable from bad auth)", async () => {
    const res = await ingest("src-nope", "ping", { body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("disabled source → 401 with the SAME body; no event stored", async () => {
    const { id, token } = await makeSource();
    storageRef.current.state.sources.get(id)!.enabled = false;
    const res = await ingest(id, "ping", { headers: { "x-auto-event-token": token }, body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(storageRef.current.state.received.get(id)).toBeUndefined();
  });

  it("missing / wrong token → 401 with the SAME body", async () => {
    const { id } = await makeSource();
    const missing = await ingest(id, "ping", { body: "{}" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    const wrong = await ingest(id, "ping", { headers: { "x-auto-event-token": "nope" }, body: "{}" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
  });

  it("?token= query auth works for custom sources", async () => {
    const { id, token } = await makeSource();
    const { POST } = await import("@/app/api/hooks/auto/events/[sourceId]/[eventName]/route");
    const res = await POST(
      new Request(`https://forge.example/api/hooks/auto/events/${id}/ping?token=${encodeURIComponent(token)}`, {
        method: "POST",
        body: "{}"
      }),
      { params: Promise.resolve({ sourceId: id, eventName: "ping" }) }
    );
    expect(res.status).toBe(202);
  });

  it("malformed event name → 400", async () => {
    const { id, token } = await makeSource();
    const res = await ingest(id, "bad name!", { headers: { "x-auto-event-token": token }, body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("ingest security — provider signatures", () => {
  async function makeGithubSource(secret = "gh-hmac-secret") {
    return makeSource({ kind: "provider", provider: "github", signingSecret: secret });
  }

  it("signature-mode sources REJECT token auth (even the source's own valid token)", async () => {
    const { id, token } = await makeGithubSource();
    const res = await ingest(id, "push", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ ok: true })
    });
    expect(res.status).toBe(401);
  });

  it("github: valid X-Hub-Signature-256 over the RAW body → 202", async () => {
    const { id } = await makeGithubSource("gh-hmac-secret");
    const body = JSON.stringify({ action: "opened" });
    const sig = "sha256=" + createHmac("sha256", "gh-hmac-secret").update(body, "utf8").digest("hex");
    const res = await ingest(id, "push", {
      headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
      body
    });
    expect(res.status).toBe(202);
    expect(storageRef.current.state.received.get(id)).toHaveLength(1);
  });

  it("github: tampered body → 401, no event stored", async () => {
    const { id } = await makeGithubSource("gh-hmac-secret");
    const body = JSON.stringify({ action: "opened" });
    const sig = "sha256=" + createHmac("sha256", "gh-hmac-secret").update(body, "utf8").digest("hex");
    const res = await ingest(id, "push", {
      headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
      body: JSON.stringify({ action: "TAMPERED" })
    });
    expect(res.status).toBe(401);
    expect(storageRef.current.state.received.get(id)).toBeUndefined();
  });

  it("github source with NO stored signing secret → uniform 401 (cannot verify = reject)", async () => {
    const { id } = await makeSource({ kind: "provider", provider: "github" });
    const body = "{}";
    const sig = "sha256=" + createHmac("sha256", "whatever").update(body, "utf8").digest("hex");
    const res = await ingest(id, "push", { headers: { "x-hub-signature-256": sig }, body });
    expect(res.status).toBe(401);
  });
});

describe("ingest security — SNS", () => {
  it("SubscriptionConfirmation with a VALID sns host → confirmation fetch + 200, NO event stored", async () => {
    const { id } = await makeSource({ kind: "provider", provider: "sns" });
    const fetched: string[] = [];
    const ingestMod = await import("@/server/core/event-ingest");
    ingestMod.setEventIngestOverridesForTests({
      fetchImpl: async (url: string) => {
        fetched.push(url);
        return { ok: true, text: async () => "" };
      }
    });
    const res = await ingest(id, "sns-event", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Type: "SubscriptionConfirmation",
        SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc"
      })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(fetched).toEqual(["https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc"]);
    expect(storageRef.current.state.received.get(id)).toBeUndefined();
  });

  it("SubscriptionConfirmation with a NON-SNS host → 401 and fetch is NEVER called (SSRF gate)", async () => {
    const { id } = await makeSource({ kind: "provider", provider: "sns" });
    const fetched: string[] = [];
    const ingestMod = await import("@/server/core/event-ingest");
    ingestMod.setEventIngestOverridesForTests({
      fetchImpl: async (url: string) => {
        fetched.push(url);
        return { ok: true, text: async () => "" };
      }
    });
    const res = await ingest(id, "sns-event", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Type: "SubscriptionConfirmation",
        SubscribeURL: "https://sns.us-east-1.amazonaws.com.evil.com/confirm"
      })
    });
    expect(res.status).toBe(401);
    expect(fetched).toEqual([]);
  });

  it("Notification with an invalid signature → 401; cert fetched ONLY for a valid sns host", async () => {
    const { id } = await makeSource({ kind: "provider", provider: "sns" });
    const fetched: string[] = [];
    const ingestMod = await import("@/server/core/event-ingest");
    ingestMod.setEventIngestOverridesForTests({
      fetchImpl: async (url: string) => {
        fetched.push(url);
        return { ok: true, text: async () => "not-a-cert" };
      }
    });
    const base = {
      Type: "Notification",
      Message: "m",
      MessageId: "id",
      Timestamp: "2026-07-02T00:00:00.000Z",
      TopicArn: "arn:aws:sns:us-east-1:1:topic",
      SignatureVersion: "1",
      Signature: "AAAA"
    };
    // Valid cert host → the injected fetch IS consulted, verification fails.
    const valid = await ingest(id, "sns-event", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem" })
    });
    expect(valid.status).toBe(401);
    expect(fetched).toEqual(["https://sns.us-east-1.amazonaws.com/cert.pem"]);
    // Evil cert host → NO fetch at all.
    fetched.length = 0;
    const evil = await ingest(id, "sns-event", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, SigningCertURL: "https://evil.example/cert.pem" })
    });
    expect(evil.status).toBe(401);
    expect(fetched).toEqual([]);
  });
});

describe("ingest limits — payload cap + rate limit", () => {
  it("oversize payload → 413, no event stored", async () => {
    const { id, token } = await makeSource();
    const big = "x".repeat(65_537); // EVENT_PAYLOAD_MAX_BYTES + 1
    const res = await ingest(id, "ping", { headers: { "x-auto-event-token": token }, body: big });
    expect(res.status).toBe(413);
    expect(storageRef.current.state.received.get(id)).toBeUndefined();
  });

  it("per-source bucket exhaustion → 429 + Retry-After; refill re-admits (fake clock)", async () => {
    const { id, token } = await makeSource();
    let clock = 1_000_000;
    const ingestMod = await import("@/server/core/event-ingest");
    ingestMod.setEventIngestOverridesForTests({ nowMs: () => clock });
    // Drain the 120-token burst (well under the 300/min user bucket? no — the
    // user bucket also drains; source hits empty FIRST at 121).
    for (let i = 0; i < 120; i++) {
      const res = await ingest(id, "ping", { headers: { "x-auto-event-token": token }, body: "{}" });
      expect(res.status).toBe(202);
    }
    const limited = await ingest(id, "ping", { headers: { "x-auto-event-token": token }, body: "{}" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // REJECTED, not queued: nothing new in the ring buffer.
    expect(storageRef.current.state.received.get(id)).toHaveLength(120);
    // Advance the fake clock 2s → one token refilled (60/min) → admitted again.
    clock += 2_000;
    const after = await ingest(id, "ping", { headers: { "x-auto-event-token": token }, body: "{}" });
    expect(after.status).toBe(202);
  });

  it("per-user limit sums across the user's sources (300/min)", async () => {
    let clock = 2_000_000;
    const ingestMod = await import("@/server/core/event-ingest");
    ingestMod.setEventIngestOverridesForTests({ nowMs: () => clock });
    const a = await makeSource({ name: "a" });
    const b = await makeSource({ name: "b" });
    const c = await makeSource({ name: "c" });
    const sourcesArr = [a, b, c];
    // 300 accepted posts spread over three sources (100 each — under the
    // per-source burst), draining the shared user bucket.
    for (let i = 0; i < 300; i++) {
      const s = sourcesArr[i % 3]!;
      const res = await ingest(s.id, "ping", { headers: { "x-auto-event-token": s.token }, body: "{}" });
      expect(res.status).toBe(202);
    }
    const limited = await ingest(a.id, "ping", { headers: { "x-auto-event-token": a.token }, body: "{}" });
    expect(limited.status).toBe(429);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// TokenBucketLimiter unit (exhaustion + refill with a fake clock)
// ---------------------------------------------------------------------------

describe("TokenBucketLimiter", () => {
  it("drains to zero, reports Retry-After, and refills over time", async () => {
    const { TokenBucketLimiter } = await import("@/server/core/event-ingest");
    let clock = 0;
    const bucket = new TokenBucketLimiter(2, 60, () => clock);
    expect(bucket.take("k").allowed).toBe(true);
    expect(bucket.take("k").allowed).toBe(true);
    const denied = bucket.take("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    clock += 1_000; // 1s at 60/min = exactly one token back
    expect(bucket.take("k").allowed).toBe(true);
    expect(bucket.take("k").allowed).toBe(false);
    // Independent keys don't share tokens.
    expect(bucket.take("other").allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fan-out cap (L2.5) + concurrency cap (L4)
// ---------------------------------------------------------------------------

describe("fan-out + concurrency caps", () => {
  it("fan-out is capped at MAX_SUBSCRIPTIONS_PER_EVENT (20) subscribed triggers", async () => {
    seedApproval();
    const { id, token } = await makeSource();
    for (let i = 0; i < 25; i++) await makeTrigger(id);
    const res = await ingest(id, "ping", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ n: 1 })
    });
    expect(res.status).toBe(202);
    // Exactly 20 triggers were consumed (one fire log each); 5 never saw it.
    const logged = [...storageRef.current.state.fireLogs.values()].flat();
    expect(logged).toHaveLength(20);
    expect(storageRef.current.state.runs).toHaveLength(20);
  });

  it("L4: over the concurrency cap → suppressed_concurrency fire log, NO run created, no circuit penalty", async () => {
    process.env.AUTO_MAX_CONCURRENT_RUNS = "2";
    seedApproval();
    const { id, token } = await makeSource();
    for (let i = 0; i < 4; i++) await makeTrigger(id);
    const res = await ingest(id, "ping", {
      headers: { "x-auto-event-token": token, "content-type": "application/json" },
      body: JSON.stringify({ n: 1 })
    });
    expect(res.status).toBe(202);
    // The dispatcher is a no-op, so the 2 created runs stay ACTIVE (queued) and
    // the remaining fires breach the cap — load-shedding, NOT an error.
    expect(storageRef.current.state.runs).toHaveLength(2);
    const logs = [...storageRef.current.state.fireLogs.values()].flat();
    const outcomes = logs.map((l) => l.outcome).sort();
    expect(outcomes).toEqual(["run_created", "run_created", "suppressed_concurrency", "suppressed_concurrency"]);
    const shedLog = logs.find((l) => l.outcome === "suppressed_concurrency")!;
    expect(String(shedLog.detail)).toMatch(/active run/i);
    // Shedding does not count toward the circuit breaker.
    for (const t of storageRef.current.state.triggers.values()) {
      const failures = (t.circuit as { consecutiveFailures?: number } | undefined)?.consecutiveFailures ?? 0;
      expect(failures).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Sweep extension (forge mirror)
// ---------------------------------------------------------------------------

describe("sweep extension — schedule-TYPE triggers (forge)", () => {
  it("service-key sweep also runs due schedule triggers", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = "sweep-key";
    seedApproval();
    const trigger = await makeTrigger("unused", {
      type: "schedule",
      config: { cron: "*/5 * * * *" },
      mapping: { promptTemplate: "tick" }
    });
    storageRef.current.state.triggers.get(trigger.id)!.cursor = "2020-01-01T00:00:00.000Z";

    const sweep = await import("@/app/api/internal/auto/sweep/route");
    const res = await sweep.POST(
      new Request("https://forge.example/api/internal/auto/sweep", {
        method: "POST",
        headers: { "x-service-key": "sweep-key" }
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { triggerSweep: { dispatched: number } };
    expect(body.triggerSweep.dispatched).toBe(1);
    expect(storageRef.current.state.runs[0]!.trigger).toBe("schedule");
    expect(storageRef.current.state.runs[0]!.triggerId).toBe(trigger.id);
  });
});
