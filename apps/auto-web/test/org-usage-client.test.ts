// Fail-open safety test for server/core/org-usage-client.ts (org budgets v2).
//
// checkOrgUsage() MUST return undefined (never throw) in every absence/error case
// so a run is NEVER blocked because Profile is unreachable/unconfigured — only a
// well-formed, found, affirmatively-not-allowed response is enforced by the gate.
// recordOrgUsage() is best-effort: it must NEVER throw in any case (it swallows
// all errors), since governance accounting must not affect the run result.
//
// Mocking approach mirrors org-key-client.test.ts: env vars control
// isProfileEnabled()/getProfileBaseUrl() (read at call time); global fetch is
// stubbed per-case; vi.resetModules() before each test gives a fresh module load.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROFILE_BASE = "https://profile.example.test";
const SERVICE_KEY = "test-svc-key-abc123";
const USER_ID = "user-usage-test-1";
const PERIOD = "2026-06";

async function loadSubject() {
  return import("@/server/core/org-usage-client");
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

const ALLOWED_CHECK = {
  allowed: true,
  memberRemainingCents: null,
  memberRemainingMinutes: null,
  poolRemainingCents: null,
  poolRemainingMinutes: null,
};
const BLOCKED_CHECK = {
  allowed: false,
  memberRemainingCents: 0,
  memberRemainingMinutes: null,
  poolRemainingCents: null,
  poolRemainingMinutes: null,
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.DISABLE_MARKET;
  delete process.env.SELF_HOST;
  delete process.env.AUTH_PROVIDER;
  process.env.PROFILE_API_BASE_URL = PROFILE_BASE;
  process.env.PROFILE_SERVICE_KEY = SERVICE_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("checkOrgUsage — fail-open in every absence/error case (→ undefined)", () => {
  it("(a) Profile not configured", async () => {
    delete process.env.PROFILE_API_BASE_URL;
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(b) PROFILE_SERVICE_KEY unset (fetch never called)", async () => {
    delete process.env.PROFILE_SERVICE_KEY;
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be called when service key is absent");
    });
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(b2) PROFILE_SERVICE_KEY empty string", async () => {
    process.env.PROFILE_SERVICE_KEY = "";
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be called when service key is empty");
    });
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(c) non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => errorResponse(503));
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(d) fetch throws a network error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(d2) fetch throws an AbortError (timeout)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(e) body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("not json {{{", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });

  it("(e2) body fails schema parse", async () => {
    vi.stubGlobal("fetch", async () => okResponse({ unexpected: "shape" }));
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toBeUndefined();
  });
});

describe("checkOrgUsage — returns the resolved check on a valid response", () => {
  it("returns { found:false } (no org / ambiguous) and the gate proceeds", async () => {
    vi.stubGlobal("fetch", async () => okResponse({ found: false }));
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toEqual({ found: false });
  });

  it("returns { found:true, check } when the org allows the run", async () => {
    vi.stubGlobal("fetch", async () =>
      okResponse({ found: true, orgId: "org1", check: ALLOWED_CHECK }),
    );
    const { checkOrgUsage } = await loadSubject();
    await expect(checkOrgUsage(USER_ID, PERIOD)).resolves.toEqual({
      found: true,
      check: ALLOWED_CHECK,
    });
  });

  it("returns { found:true, check:{allowed:false} } — the gate's block signal", async () => {
    vi.stubGlobal("fetch", async () =>
      okResponse({ found: true, orgId: "org1", check: BLOCKED_CHECK }),
    );
    const { checkOrgUsage } = await loadSubject();
    const result = await checkOrgUsage(USER_ID, PERIOD);
    expect(result?.found).toBe(true);
    expect(result?.check?.allowed).toBe(false);
  });

  it("GETs the user-keyed check route with the service-key header + period query", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: url.toString(), init: init ?? {} };
      return okResponse({ found: false });
    });
    const { checkOrgUsage } = await loadSubject();
    await checkOrgUsage(USER_ID, PERIOD);
    expect(captured).toBeDefined();
    expect(captured!.url).toContain(PROFILE_BASE);
    expect(captured!.url).toContain(`/users/${USER_ID}/org-usage/check`);
    expect(captured!.url).toContain(`period=${PERIOD}`);
    expect(captured!.init.method).toBe("GET");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-profile-service-key"]).toBe(SERVICE_KEY);
  });
});

describe("recordOrgUsage — best-effort, never throws", () => {
  it("does not throw and does not fetch when Profile is not configured", async () => {
    delete process.env.PROFILE_API_BASE_URL;
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be called when Profile is disabled");
    });
    const { recordOrgUsage } = await loadSubject();
    await expect(recordOrgUsage(USER_ID, PERIOD, 100, 2)).resolves.toBeUndefined();
  });

  it("does not throw and does not fetch when the service key is absent", async () => {
    delete process.env.PROFILE_SERVICE_KEY;
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch must not be called when service key is absent");
    });
    const { recordOrgUsage } = await loadSubject();
    await expect(recordOrgUsage(USER_ID, PERIOD, 100, 2)).resolves.toBeUndefined();
  });

  it("swallows a network error (never throws)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { recordOrgUsage } = await loadSubject();
    await expect(recordOrgUsage(USER_ID, PERIOD, 100, 2)).resolves.toBeUndefined();
  });

  it("swallows a non-2xx response (never throws)", async () => {
    vi.stubGlobal("fetch", async () => errorResponse(503));
    const { recordOrgUsage } = await loadSubject();
    await expect(recordOrgUsage(USER_ID, PERIOD, 100, 2)).resolves.toBeUndefined();
  });

  it("POSTs the user-keyed record route with the service-key header + body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: url.toString(), init: init ?? {} };
      return okResponse({ recorded: true, orgId: "org1" });
    });
    const { recordOrgUsage } = await loadSubject();
    await recordOrgUsage(USER_ID, PERIOD, 150, 3.5);
    expect(captured).toBeDefined();
    expect(captured!.url).toContain(PROFILE_BASE);
    expect(captured!.url).toContain(`/users/${USER_ID}/org-usage/record`);
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-profile-service-key"]).toBe(SERVICE_KEY);
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      period: PERIOD,
      addCents: 150,
      addMinutes: 3.5,
    });
  });
});
