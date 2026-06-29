// Fail-open safety test for server/core/org-key-client.ts resolveOrgApiKey().
//
// resolveOrgApiKey() MUST return undefined (never throw) in every absence/error
// case so a run is never failed because Market is unreachable or unconfigured.
// Only the one "valid { found:true, apiKey, providerType:'anthropic' }" path
// should return the key. All other paths — including future errors we haven't
// thought of — fall through to the operator/platform key.
//
// Mocking approach: env vars control isMarketEnabled()/getMarketBaseUrl() (they
// read process.env at call time). global fetch is stubbed per-case via
// vi.stubGlobal. vi.resetModules() before each test ensures a fresh module load
// so no cached env state bleeds between cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Constants shared across all cases
// ---------------------------------------------------------------------------

const MARKET_BASE = "https://market.example.test";
const SERVICE_KEY = "test-svc-key-abc123";
const USER_ID = "user-org-test-1";
const ORG_API_KEY = "sk-ant-api03-ORGSHAREDKEY1234567890";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load org-key-client fresh (after env + fetch stubs are set). */
async function loadSubject() {
  const mod = await import("@/server/core/org-key-client");
  return mod.resolveOrgApiKey;
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "err" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // Default: hosted instance, Market enabled, service key set.
  // Individual cases override as needed.
  delete process.env.DISABLE_MARKET;
  delete process.env.SELF_HOST;
  delete process.env.AUTH_PROVIDER;
  process.env.AGENTKITMARKET_BASE_URL = MARKET_BASE;
  process.env.MARKET_SERVICE_KEY = SERVICE_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  // Restore env exactly (avoids cross-test pollution).
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

// ---------------------------------------------------------------------------
// Cases — every one must return undefined (never throw)
// ---------------------------------------------------------------------------

describe("resolveOrgApiKey — fail-open in every absence/error case", () => {
  // (a) Market disabled (DISABLE_MARKET=true → isMarketEnabled() is false)
  it("(a) returns undefined when Market is disabled", async () => {
    process.env.DISABLE_MARKET = "true";
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (a2) Self-host with no AGENTKITMARKET_BASE_URL → isMarketEnabled() false
  it("(a2) returns undefined when self-host with no Market base URL", async () => {
    process.env.AUTH_PROVIDER = "oidc";
    delete process.env.AGENTKITMARKET_BASE_URL;
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (b) MARKET_SERVICE_KEY unset
  it("(b) returns undefined when MARKET_SERVICE_KEY is unset", async () => {
    delete process.env.MARKET_SERVICE_KEY;
    const resolveOrgApiKey = await loadSubject();
    // fetch should never be called; stub it to explode if it is
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be called when service key is absent");
    });
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (b2) MARKET_SERVICE_KEY is an empty string
  it("(b2) returns undefined when MARKET_SERVICE_KEY is empty string", async () => {
    process.env.MARKET_SERVICE_KEY = "";
    const resolveOrgApiKey = await loadSubject();
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be called when service key is empty");
    });
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (c) Backend returns non-2xx
  it("(c) returns undefined on non-2xx response (e.g. 503)", async () => {
    vi.stubGlobal("fetch", async () => errorResponse(503));
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  it("(c2) returns undefined on non-2xx response (e.g. 401)", async () => {
    vi.stubGlobal("fetch", async () => errorResponse(401));
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (d) fetch rejects (network error / timeout / AbortError)
  it("(d) returns undefined when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  it("(d2) returns undefined when fetch throws an AbortError (timeout)", async () => {
    vi.stubGlobal("fetch", async () => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      throw err;
    });
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (e) Response body is not valid JSON (unparseable body)
  it("(e) returns undefined when response body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("this is not json {{{", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (e2) Response body is valid JSON but does not match the schema
  it("(e2) returns undefined when response body fails schema parse", async () => {
    vi.stubGlobal("fetch", async () =>
      okResponse({ unexpected: "shape", no_found_field: true }),
    );
    const resolveOrgApiKey = await loadSubject();
    // `found` field is missing → safeParse fails → undefined
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (f) Backend returns { found: false }
  it("(f) returns undefined when backend responds { found: false }", async () => {
    vi.stubGlobal("fetch", async () => okResponse({ found: false }));
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (f2) { found: true } but apiKey is absent
  it("(f2) returns undefined when found:true but apiKey is absent", async () => {
    vi.stubGlobal("fetch", async () =>
      okResponse({ found: true, providerType: "anthropic" }),
    );
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });

  // (f3) { found: true, apiKey } but the org's providerType does NOT match the
  // requested provider type (we asked for anthropic, the org key is openai).
  it("(f3) returns undefined when providerType does not match the requested type", async () => {
    vi.stubGlobal("fetch", async () =>
      okResponse({ found: true, apiKey: ORG_API_KEY, providerType: "openai" }),
    );
    const resolveOrgApiKey = await loadSubject();
    await expect(resolveOrgApiKey(USER_ID, "anthropic")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Happy path — valid response returns the key
// ---------------------------------------------------------------------------

describe("resolveOrgApiKey — returns key on valid response", () => {
  it("returns { apiKey, providerType:'anthropic' } on { found:true, apiKey, providerType:'anthropic' }", async () => {
    vi.stubGlobal("fetch", async () =>
      okResponse({ found: true, apiKey: ORG_API_KEY, providerType: "anthropic" }),
    );
    const resolveOrgApiKey = await loadSubject();
    const result = await resolveOrgApiKey(USER_ID, "anthropic");
    expect(result).toEqual({ apiKey: ORG_API_KEY, providerType: "anthropic" });
  });

  it("returns a NON-anthropic provider key when its type matches the request", async () => {
    const OPENAI_KEY = "sk-openai-ORGSHAREDKEY1234567890";
    vi.stubGlobal("fetch", async () =>
      okResponse({ found: true, apiKey: OPENAI_KEY, providerType: "openai" }),
    );
    const resolveOrgApiKey = await loadSubject();
    const result = await resolveOrgApiKey(USER_ID, "openai");
    expect(result).toEqual({ apiKey: OPENAI_KEY, providerType: "openai" });
  });

  it("includes baseUrl when the backend provides one", async () => {
    const BASE = "https://custom.anthropic.internal/v1";
    vi.stubGlobal("fetch", async () =>
      okResponse({
        found: true,
        apiKey: ORG_API_KEY,
        providerType: "anthropic",
        baseUrl: BASE,
      }),
    );
    const resolveOrgApiKey = await loadSubject();
    const result = await resolveOrgApiKey(USER_ID, "anthropic");
    expect(result).toEqual({ apiKey: ORG_API_KEY, providerType: "anthropic", baseUrl: BASE });
  });

  it("sends the correct service-key header and POST body", async () => {
    let capturedRequest: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = { url: url.toString(), init: init ?? {} };
      return okResponse({ found: true, apiKey: ORG_API_KEY, providerType: "anthropic" });
    });

    const resolveOrgApiKey = await loadSubject();
    await resolveOrgApiKey(USER_ID, "anthropic");

    expect(capturedRequest).toBeDefined();
    // URL must end with the contracts route path
    expect(capturedRequest!.url).toContain("/api/forge/service/me/org-api-key");
    // Must be a POST
    expect(capturedRequest!.init.method).toBe("POST");
    // Must send the service key in the right header
    const headers = capturedRequest!.init.headers as Record<string, string>;
    expect(headers["x-agentkit-service-key"]).toBe(SERVICE_KEY);
    // Body must include the userId AND the requested providerType (per-provider resolve)
    const body = JSON.parse(capturedRequest!.init.body as string);
    expect(body.userId).toBe(USER_ID);
    expect(body.providerType).toBe("anthropic");
  });
});
