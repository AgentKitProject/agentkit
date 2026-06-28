/**
 * M6 Slice 2 — web-Forge buyer entry point: the entitled-kit listing seam that
 * backs the "run your protected kits" discovery surface in Run / Chat.
 *
 * Covers:
 *   • `listEntitledKitsViaService` (server/core/protected-kits.ts) — the
 *     server-to-service Market call that lists the user's PROTECTED entitled
 *     kits: it sends MARKET_SERVICE_KEY (server-only) + the asserted userId,
 *     returns the browser-safe shape (name/slug/marketKitId), and FAILS CLOSED
 *     (empty) when Market is disabled, the key is unset, or the service errors.
 *   • the GET /api/forge/entitled-kits route — cookie auth (401 unauth), gating
 *     on isMarketEnabled (empty when disabled), browser-safe passthrough.
 *
 * The Market service HTTP endpoint + the AuthKit cookie session are MOCKED; the
 * REAL client + route run. We assert the secret service key is sent on the wire
 * but the response is value-free (no entitlement internals, no kit content).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AuthKit must be mocked before the route (which imports @/lib/auth) is loaded.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
  getSignInUrl: vi.fn(),
  handleAuth: vi.fn(),
  saveSession: vi.fn(),
  authkitMiddleware: vi.fn(() => vi.fn())
}));

const USER = "buyer-7";
const MARKET_BASE = "https://market.example.test";
const SERVICE_KEY = "test-market-service-key";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.AGENTKITMARKET_BASE_URL = MARKET_BASE;
  process.env.MARKET_SERVICE_KEY = SERVICE_KEY;
  process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID = "client_test";
  delete process.env.SELF_HOST;
  delete process.env.AUTH_PROVIDER;
  delete process.env.DISABLE_MARKET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

/** A fetch fake for the Market entitled-kits endpoint. Records the request so we
 *  can assert the service key + URL, and returns the supplied response. */
function makeEntitledKitsFetch(opts: {
  status?: number;
  body?: unknown;
  hits: { url?: string; serviceKey?: string | null; method?: string; userId?: unknown };
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    opts.hits.url = String(input);
    opts.hits.method = init?.method;
    const headers = new Headers(init?.headers);
    opts.hits.serviceKey = headers.get("x-agentkit-service-key");
    try {
      opts.hits.userId = JSON.parse(String(init?.body)).userId;
    } catch {
      /* ignore */
    }
    const status = opts.status ?? 200;
    return new Response(JSON.stringify(opts.body ?? { kits: [] }), {
      status,
      headers: { "content-type": "application/json" }
    });
  });
}

describe("listEntitledKitsViaService — server-to-service entitled-kit listing", () => {
  it("sends MARKET_SERVICE_KEY + asserted userId and returns browser-safe kits", async () => {
    const hits: { url?: string; serviceKey?: string | null; method?: string; userId?: unknown } = {};
    vi.stubGlobal(
      "fetch",
      makeEntitledKitsFetch({
        body: {
          kits: [
            { marketKitId: "mk-1", slug: "secret-rubric", name: "Secret Rubric" },
            { marketKitId: "mk-2", slug: "pro-pack", name: "Pro Pack" }
          ]
        },
        hits
      })
    );

    const { listEntitledKitsViaService } = await import("@/server/core/protected-kits");
    const kits = await listEntitledKitsViaService(USER);

    // The service key (server-only secret) is sent on the wire; userId asserted.
    expect(hits.serviceKey).toBe(SERVICE_KEY);
    expect(hits.method).toBe("POST");
    expect(hits.userId).toBe(USER);
    expect(hits.url).toBe(`${MARKET_BASE}/api/forge/service/me/entitled-kits`);

    // Browser-safe shape only — no entitlement internals, no content.
    expect(kits).toEqual([
      { marketKitId: "mk-1", slug: "secret-rubric", name: "Secret Rubric" },
      { marketKitId: "mk-2", slug: "pro-pack", name: "Pro Pack" }
    ]);
  });

  it("fails CLOSED (empty, no fetch) when Market is disabled (self-host, no Market)", async () => {
    process.env.AUTH_PROVIDER = "oidc"; // self-host signal
    delete process.env.AGENTKITMARKET_BASE_URL; // no own Market → disabled
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { listEntitledKitsViaService } = await import("@/server/core/protected-kits");
    const kits = await listEntitledKitsViaService(USER);

    expect(kits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled(); // never phones home
  });

  it("fails CLOSED (empty, no fetch) when MARKET_SERVICE_KEY is unset", async () => {
    delete process.env.MARKET_SERVICE_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { listEntitledKitsViaService } = await import("@/server/core/protected-kits");
    const kits = await listEntitledKitsViaService(USER);

    expect(kits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails CLOSED (empty) on a non-2xx service response", async () => {
    const hits = {};
    vi.stubGlobal("fetch", makeEntitledKitsFetch({ status: 502, body: { error: "backend_unavailable" }, hits }));

    const { listEntitledKitsViaService } = await import("@/server/core/protected-kits");
    expect(await listEntitledKitsViaService(USER)).toEqual([]);
  });

  it("drops malformed entries that fail the browser-safe schema", async () => {
    const hits = {};
    vi.stubGlobal(
      "fetch",
      makeEntitledKitsFetch({
        // Missing marketKitId → the whole response fails safeParse → [].
        body: { kits: [{ slug: "x", name: "y" }] },
        hits
      })
    );
    const { listEntitledKitsViaService } = await import("@/server/core/protected-kits");
    expect(await listEntitledKitsViaService(USER)).toEqual([]);
  });
});

describe("GET /api/forge/entitled-kits route", () => {
  async function loadRoute() {
    return import("@/app/api/forge/entitled-kits/route");
  }

  it("401s when no cookie session", async () => {
    const auth = await import("@/lib/auth");
    vi.spyOn(auth, "requireUserForApi").mockRejectedValue(new auth.UnauthorizedError("Sign in required."));

    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the browser-safe kit list for an authed user", async () => {
    const auth = await import("@/lib/auth");
    vi.spyOn(auth, "requireUserForApi").mockResolvedValue({ id: USER, email: "b@example.test" } as never);

    const hits = {};
    vi.stubGlobal(
      "fetch",
      makeEntitledKitsFetch({ body: { kits: [{ marketKitId: "mk-1", slug: "s", name: "N" }] }, hits })
    );

    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kits: unknown[] };
    expect(body.kits).toEqual([{ marketKitId: "mk-1", slug: "s", name: "N" }]);
  });

  it("returns an empty list (gated) when Market is disabled, without calling out", async () => {
    process.env.AUTH_PROVIDER = "oidc";
    delete process.env.AGENTKITMARKET_BASE_URL;
    const auth = await import("@/lib/auth");
    vi.spyOn(auth, "requireUserForApi").mockResolvedValue({ id: USER, email: "b@example.test" } as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).kits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
