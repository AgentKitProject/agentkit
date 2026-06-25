import { describe, expect, test } from "vitest";

import {
  listFavorites,
  addFavorite,
  removeFavorite,
  normalizeFavorite
} from "../src/market/favorites.js";
import { forgeFavoriteRoutes } from "../src/market/routes.js";
import type { FetchLike, FetchLikeResponse } from "../src/market/http.js";
import type { StoredSession, TokenStore } from "../src/market/types.js";

function farFutureJwt(): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url({ alg: "RS256" })}.${b64url({ exp })}.sig`;
}

class MemoryStore implements TokenStore {
  session: StoredSession | null = {
    accessToken: farFutureJwt(),
    refreshToken: "rt",
    connectedAt: new Date().toISOString()
  };
  async get() {
    return this.session;
  }
  async set(session: StoredSession) {
    this.session = session;
  }
  async clear() {
    this.session = null;
  }
}

function jsonResp(status: number, body: unknown): FetchLikeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
  };
}

const BASE = "https://market.agentkitproject.com";
const opts = (fetchImpl: FetchLike) => ({
  clientId: "client_abc",
  marketBaseUrl: BASE,
  fetch: fetchImpl
});

describe("cloud favorites routes", () => {
  test("route builders", () => {
    expect(forgeFavoriteRoutes.list()).toBe("/api/forge/favorites");
    expect(forgeFavoriteRoutes.remove("kit 1")).toBe(
      "/api/forge/favorites/kit%201"
    );
  });
});

describe("normalizeFavorite", () => {
  test("coerces a full record", () => {
    const fav = normalizeFavorite({
      kitId: "k1",
      slug: "my-kit",
      addedAt: "2026-06-15T00:00:00Z",
      displayName: "My Kit",
      summary: "A kit",
      publisherName: "Acme"
    });
    expect(fav).toEqual({
      kitId: "k1",
      slug: "my-kit",
      addedAt: "2026-06-15T00:00:00Z",
      displayName: "My Kit",
      summary: "A kit",
      publisherName: "Acme"
    });
  });

  test("drops records with neither kitId nor slug", () => {
    expect(normalizeFavorite({})).toBeNull();
    expect(normalizeFavorite(null)).toBeNull();
  });

  test("falls back across slug/kitId", () => {
    expect(normalizeFavorite({ slug: "only-slug" })).toMatchObject({
      kitId: "only-slug",
      slug: "only-slug"
    });
  });
});

describe("listFavorites", () => {
  test("GETs /api/forge/favorites with bearer and unwraps items", async () => {
    const store = new MemoryStore();
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers?.Authorization as string) ?? "";
      return jsonResp(200, {
        items: [
          { kitId: "k1", slug: "kit-one", addedAt: "t1" },
          { kitId: "k2", slug: "kit-two", addedAt: "t2" },
          { junk: true }
        ]
      });
    };
    const result = await listFavorites(store, opts(fetchImpl));
    expect(seenUrl).toBe(`${BASE}/api/forge/favorites`);
    expect(seenAuth).toMatch(/^Bearer /);
    expect(result.map((f) => f.kitId)).toEqual(["k1", "k2"]);
  });
});

describe("addFavorite", () => {
  test("POSTs slug body", async () => {
    const store = new MemoryStore();
    let method = "";
    let body = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      method = init?.method ?? "";
      body = (init?.body as string) ?? "";
      return jsonResp(200, { items: [{ kitId: "k1", slug: "kit-one" }] });
    };
    const result = await addFavorite(store, { slug: "kit-one" }, opts(fetchImpl));
    expect(method).toBe("POST");
    expect(JSON.parse(body)).toEqual({ slug: "kit-one" });
    expect(result[0].kitId).toBe("k1");
  });

  test("prefers kitId body when provided", async () => {
    const store = new MemoryStore();
    let body = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      body = (init?.body as string) ?? "";
      return jsonResp(200, {});
    };
    await addFavorite(store, { kitId: "k9", slug: "ignored" }, opts(fetchImpl));
    expect(JSON.parse(body)).toEqual({ kitId: "k9" });
  });

  test("throws when neither slug nor kitId given", async () => {
    const store = new MemoryStore();
    await expect(
      addFavorite(store, {}, opts(async () => jsonResp(200, {})))
    ).rejects.toThrow(/slug or id/i);
  });
});

describe("removeFavorite", () => {
  test("DELETEs /api/forge/favorites/{kitId}", async () => {
    const store = new MemoryStore();
    let method = "";
    let url = "";
    const fetchImpl: FetchLike = async (u, init) => {
      url = u;
      method = init?.method ?? "";
      return jsonResp(204, {});
    };
    await removeFavorite(store, "k1", opts(fetchImpl));
    expect(method).toBe("DELETE");
    expect(url).toBe(`${BASE}/api/forge/favorites/k1`);
  });

  test("treats 404 as idempotent success", async () => {
    const store = new MemoryStore();
    await expect(
      removeFavorite(store, "gone", opts(async () => jsonResp(404, {})))
    ).resolves.toBeUndefined();
  });

  test("throws on a kit id that is empty", async () => {
    const store = new MemoryStore();
    await expect(
      removeFavorite(store, "  ", opts(async () => jsonResp(200, {})))
    ).rejects.toThrow(/kit id is required/i);
  });
});
