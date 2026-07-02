// Gateway Phase 3 — Service-mode CONSUMER contract test.
//
// Verifies resolveProtectedSystemPromptViaService (the web-forge→market-app
// two-hop service trust for the hosted Auto worker path) WITHOUT a real network
// or a real Market. All fetch calls are intercepted by vi.stubGlobal so no HTTP
// ever leaves the process.
//
// Four invariants tested:
//   1. service_unconfigured — thrown when MARKET_SERVICE_KEY is unset.
//   2. Request shape — POSTs to the URL from marketServiceRoutes.licensedPackage,
//      sends marketServiceAuthHeader with the key, asserts userId in the body.
//      Crucially NO Authorization: Bearer and NO cookie header.
//   3. Success path — a mocked 200 returning a base64 kit zip yields a
//      non-empty systemPrompt (in-memory assembly via core).
//   4. 403 not_entitled — mocked 403 {code:"not_entitled"} surfaces as
//      ProtectedKitServiceError with code==="not_entitled".
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { marketServiceAuthHeader, marketServiceRoutes } from "@agentkitforge/contracts";

// ---------------------------------------------------------------------------
// Build a minimal valid licensed-package zip once (reuse the same fixture
// helper as protected-kits.test.ts — real packageKit + KitStore).
// ---------------------------------------------------------------------------

let dataDir: string;
let licensedZipBase64: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "akf-svc-"));
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
  const { getKitStore } = await import("@/server/store/local-disk");
  const { packageKit } = await import("@/server/core/operations");
  const store = await getKitStore();
  const meta = await store.createKit("svc_user", {
    kind: "template",
    template: "blank",
    id: "svc-protected-kit",
    name: "Service Protected Kit",
    description: "Minimal kit for service-mode contract test."
  });
  // Inject a recognisable token into AGENTKIT.md so we can assert prompt assembly.
  const tree = await store.getKitTree("svc_user", meta.kitId);
  const agentkit = tree.files.find((f) => f.path === "AGENTKIT.md");
  if (agentkit) agentkit.content = `${agentkit.content}\n\nSERVICE_RESOLUTION_TOKEN\n`;
  await store.putKitTree("svc_user", meta.kitId, tree);
  const pkg = await packageKit("svc_user", meta.kitId);
  licensedZipBase64 = Buffer.from(pkg.bytes).toString("base64");
});

afterAll(async () => {
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Each test manages MARKET_SERVICE_KEY and AGENTKITMARKET_BASE_URL directly so
// env state never bleeds between cases.
// ---------------------------------------------------------------------------
const MARKET_BASE = "https://market.test.example";
const SERVICE_KEY = "svc-test-key-abc123";
const SLUG = "svc-protected-kit";
const USER_ID = "usr_buyer_xyz";

async function importSubject() {
  return import("@/server/core/protected-kits");
}

beforeEach(() => {
  delete process.env.MARKET_SERVICE_KEY;
  process.env.AGENTKITMARKET_BASE_URL = MARKET_BASE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// (1) service_unconfigured — MARKET_SERVICE_KEY absent
// ---------------------------------------------------------------------------
describe("resolveProtectedSystemPromptViaService — service_unconfigured", () => {
  it("throws ProtectedKitServiceError(service_unconfigured) when MARKET_SERVICE_KEY is unset", async () => {
    // MARKET_SERVICE_KEY is not set (cleared in beforeEach).
    const { resolveProtectedSystemPromptViaService, ProtectedKitServiceError } = await importSubject();
    await expect(
      resolveProtectedSystemPromptViaService(USER_ID, { slug: SLUG })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProtectedKitServiceError &&
        (e as InstanceType<typeof ProtectedKitServiceError>).code === "service_unconfigured"
    );
  });
});

// ---------------------------------------------------------------------------
// (2) Request shape + (3) success path
// ---------------------------------------------------------------------------
describe("resolveProtectedSystemPromptViaService — success path", () => {
  it("POSTs to marketServiceRoutes.licensedPackage URL, sends service-key header, asserts userId, returns assembled prompt", async () => {
    process.env.MARKET_SERVICE_KEY = SERVICE_KEY;

    const capturedRequests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      }
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      capturedRequests.push({ url, method: init?.method ?? "GET", headers, body: JSON.parse(bodyText) });

      return new Response(
        JSON.stringify({
          contentBase64: licensedZipBase64,
          watermark: "wm_test",
          sha256: "deadbeef",
          slug: SLUG,
          pricing: "paid",
          downloadable: false,
          onlineOnly: true
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    vi.stubGlobal("fetch", mockFetch);

    const { resolveProtectedSystemPromptViaService } = await importSubject();
    const result = await resolveProtectedSystemPromptViaService(USER_ID, { slug: SLUG });

    // Result carries assembled prompt + pricing fields.
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.pricing).toBe("paid");
    expect(result.onlineOnly).toBe(true);

    // Prompt assembly ran — our injected token is present.
    expect(result.systemPrompt).toContain("SERVICE_RESOLUTION_TOKEN");

    // Exactly one request was made.
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];

    // URL is built from contracts route builder + the configured base.
    const expectedPath = marketServiceRoutes.licensedPackage(SLUG);
    expect(req.url).toBe(`${MARKET_BASE}${expectedPath}`);
    expect(req.method).toBe("POST");

    // Service-key header sent with the right value.
    expect(req.headers[marketServiceAuthHeader.toLowerCase()]).toBe(SERVICE_KEY);

    // userId explicitly asserted in the request body.
    expect((req.body as { userId: string }).userId).toBe(USER_ID);

    // No Authorization: Bearer header (this is NOT a user token flow).
    expect(req.headers["authorization"]).toBeUndefined();
    // No cookie header.
    expect(req.headers["cookie"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (4) 403 not_entitled surfaced as ProtectedKitServiceError
// ---------------------------------------------------------------------------
describe("resolveProtectedSystemPromptViaService — entitlement refusal", () => {
  it("throws ProtectedKitServiceError(not_entitled) on a mocked 403 {code:'not_entitled'}", async () => {
    process.env.MARKET_SERVICE_KEY = SERVICE_KEY;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "not_entitled" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const { resolveProtectedSystemPromptViaService, ProtectedKitServiceError } = await importSubject();
    await expect(
      resolveProtectedSystemPromptViaService(USER_ID, { slug: SLUG })
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProtectedKitServiceError &&
        (e as InstanceType<typeof ProtectedKitServiceError>).code === "not_entitled"
    );
  });
});
