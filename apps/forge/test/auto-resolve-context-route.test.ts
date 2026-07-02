// Internal resolve-context endpoint — service-key auth gate (THIRD auth path).
//
// We mock @/server/core/auto's resolveWorkerContext so the route runs fully
// offline; the focus is the service-key gate (503 unconfigured / 401 wrong key /
// 200 + JSON on the right key) and that the route never mixes in cookie/bearer
// auth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveWorkerContextMock = vi.fn();
vi.mock("@/server/core/auto", () => ({
  resolveWorkerContext: (...a: unknown[]) => resolveWorkerContextMock(...(a as [])),
  // The module's static fargate import + initAutoDispatcher would otherwise run;
  // stub the whole module so importing the route is offline.
  setAutoDispatcher: () => {}
}));

const SERVICE_KEY = "svc-secret-key-123456";

function makeReq(headers: Record<string, string>, body: unknown): Request {
  return new Request("https://forge.example/api/internal/auto/resolve-context", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

describe("internal resolve-context — service-key gate", () => {
  beforeEach(() => {
    resolveWorkerContextMock.mockReset();
    delete process.env.AUTO_WORKER_SERVICE_KEY;
  });
  afterEach(() => vi.restoreAllMocks());

  it("503 when AUTO_WORKER_SERVICE_KEY is unset", async () => {
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({ "x-service-key": "anything" }, { runId: "r1" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_auth_unconfigured");
    expect(resolveWorkerContextMock).not.toHaveBeenCalled();
  });

  it("401 on a wrong service key", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SERVICE_KEY;
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({ "x-service-key": "wrong-key" }, { runId: "r1" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
    expect(resolveWorkerContextMock).not.toHaveBeenCalled();
  });

  it("401 when no key is presented at all", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SERVICE_KEY;
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({}, { runId: "r1" }));
    expect(res.status).toBe(401);
  });

  it("400 when runId is missing/empty even with a valid key", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SERVICE_KEY;
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({ "x-service-key": SERVICE_KEY }, { runId: "  " }));
    expect(res.status).toBe(400);
    expect(resolveWorkerContextMock).not.toHaveBeenCalled();
  });

  it("200 + worker JSON on the correct key (x-service-key)", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SERVICE_KEY;
    resolveWorkerContextMock.mockResolvedValue({
      model: "claude-sonnet-4-6",
      systemPrompt: "SECRET PROMPT",
      tools: [{ name: "read_file", description: "", inputSchema: { type: "object" } }],
      toolNames: ["read_file"],
      inferenceMode: "byo",
      byoProvider: { apiKey: "sk-ant-secret" }
    });
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({ "x-service-key": SERVICE_KEY }, { runId: "run-9" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(resolveWorkerContextMock).toHaveBeenCalledWith("run-9");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.inferenceMode).toBe("byo");
    expect(body.toolNames).toEqual(["read_file"]);
    expect(body.systemPrompt).toBe("SECRET PROMPT");
    expect((body.byoProvider as { apiKey: string }).apiKey).toBe("sk-ant-secret");
  });

  it("accepts the key via Authorization: Bearer too", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SERVICE_KEY;
    resolveWorkerContextMock.mockResolvedValue({
      model: "m",
      tools: [],
      toolNames: [],
      inferenceMode: "managed"
    });
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({ authorization: `Bearer ${SERVICE_KEY}` }, { runId: "run-9" }));
    expect(res.status).toBe(200);
  });

  it("404 when the run cannot be resolved", async () => {
    process.env.AUTO_WORKER_SERVICE_KEY = SERVICE_KEY;
    resolveWorkerContextMock.mockRejectedValue(new Error("Run not found"));
    const { POST } = await import("@/app/api/internal/auto/resolve-context/route");
    const res = await POST(makeReq({ "x-service-key": SERVICE_KEY }, { runId: "missing" }));
    expect(res.status).toBe(404);
  });
});
