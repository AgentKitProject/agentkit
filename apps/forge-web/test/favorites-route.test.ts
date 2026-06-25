// Unit tests for the Market-backed /api/favorites route.
// Verifies that the route forwards calls to the Market cloud favorites API
// using the WorkOS access token, and handles no-token / error cases.
import { describe, expect, it, vi, beforeEach } from "vitest";

// --- mock AuthKit before importing the route ---
const withAuthMock = vi.fn();
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: (...args: unknown[]) => withAuthMock(...args) }));

// --- mock requireUserForApi (lib/auth) so withUser() passes ---
vi.mock("@/lib/auth", () => ({
  requireUserForApi: vi.fn().mockResolvedValue({ id: "user_1", email: "test@example.com" }),
  UnauthorizedError: class UnauthorizedError extends Error {}
}));

// --- mock global fetch ---
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { GET, POST, DELETE } from "@/app/api/favorites/route";

// The route reads AGENTKITMARKET_BASE_URL at module load time; fall back to the
// hard-coded default when the env var isn't set in the test environment.
const MARKET_BASE = process.env.AGENTKITMARKET_BASE_URL ?? "https://market.agentkitproject.com";

beforeEach(() => {
  withAuthMock.mockReset();
  fetchMock.mockReset();
});

function mockToken(token: string | null) {
  if (token) {
    withAuthMock.mockResolvedValue({ user: { id: "u1" }, accessToken: token });
  } else {
    withAuthMock.mockResolvedValue({ user: null });
  }
}

describe("GET /api/favorites (Market-backed)", () => {
  it("returns favorites from Market API", async () => {
    mockToken("tok-abc");
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { kitId: "kit_1", slug: "my-kit", displayName: "My Kit", publisher: "Alice", version: "v1", addedAt: "2025-01-01T00:00:00Z" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.favorites).toHaveLength(1);
    expect(body.favorites[0].marketSlug).toBe("my-kit");
    expect(body.favorites[0].marketKitId).toBe("kit_1");
    // Verify the request was made with the bearer token
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MARKET_BASE}/api/forge/favorites`);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-abc");
  });

  it("returns 401 with user-visible message when not signed in", async () => {
    mockToken(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/signed in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns error when Market API returns non-ok", async () => {
    mockToken("tok-abc");
    fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/403/);
  });
});

describe("POST /api/favorites (Market-backed)", () => {
  it("adds a favorite by slug", async () => {
    mockToken("tok-abc");
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ item: { kitId: "kit_2", slug: "new-kit", addedAt: "2025-06-01T00:00:00Z" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const req = new Request("http://localhost/api/favorites", {
      method: "POST",
      body: JSON.stringify({ marketSlug: "new-kit" }),
      headers: { "content-type": "application/json" }
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.favorite.marketSlug).toBe("new-kit");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ slug: "new-kit" });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-abc");
  });

  it("returns 401 when not signed in", async () => {
    mockToken(null);
    const req = new Request("http://localhost/api/favorites", {
      method: "POST",
      body: JSON.stringify({ marketSlug: "x" }),
      headers: { "content-type": "application/json" }
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/favorites (Market-backed)", () => {
  it("removes a favorite by marketSlug", async () => {
    mockToken("tok-abc");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const req = new Request("http://localhost/api/favorites", {
      method: "DELETE",
      body: JSON.stringify({ marketSlug: "my-kit" }),
      headers: { "content-type": "application/json" }
    });
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${MARKET_BASE}/api/forge/favorites/my-kit`);
  });

  it("returns 401 when not signed in", async () => {
    mockToken(null);
    const req = new Request("http://localhost/api/favorites", {
      method: "DELETE",
      body: JSON.stringify({ marketSlug: "x" }),
      headers: { "content-type": "application/json" }
    });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });
});
