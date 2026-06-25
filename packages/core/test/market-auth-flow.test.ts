import { describe, expect, test, vi, afterEach } from "vitest";

import {
  ensureAccessToken,
  login,
  ReconnectRequiredError,
  refreshAccessToken
} from "../src/market/auth.js";
import type { StoredSession, TokenStore } from "../src/market/types.js";

/** In-memory TokenStore for deterministic flow tests. */
class MemoryStore implements TokenStore {
  session: StoredSession | null = null;
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

function jwtWithExp(exp: number): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64url({ alg: "RS256" })}.${b64url({ exp })}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("login device flow", () => {
  test("surfaces the prompt and persists the session after polling", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push("authorize");
        return jsonResponse(200, {
          device_code: "dev_1",
          user_code: "WXYZ-9876",
          verification_uri: "https://example.com/device",
          verification_uri_complete: "https://example.com/device?code=WXYZ-9876",
          expires_in: 600,
          interval: 5
        });
      })
      .mockImplementationOnce(async () => {
        calls.push("poll-pending");
        return jsonResponse(400, { error: "authorization_pending" });
      })
      .mockImplementationOnce(async () => {
        calls.push("poll-success");
        return jsonResponse(200, {
          access_token: "at-1",
          refresh_token: "rt-1",
          user: { id: "u1" }
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    let prompted: { userCode: string; verificationUri: string } | null = null;
    const result = await login(
      {
        clientId: "client_abc",
        onPrompt: (p) => {
          prompted = { userCode: p.userCode, verificationUri: p.verificationUri };
        },
        sleep: async () => {},
        now: () => 1000
      },
      store
    );

    expect(prompted).toEqual({
      userCode: "WXYZ-9876",
      verificationUri: "https://example.com/device"
    });
    expect(result.user?.id).toBe("u1");
    expect(store.session?.accessToken).toBe("at-1");
    expect(store.session?.refreshToken).toBe("rt-1");
    expect(calls).toEqual(["authorize", "poll-pending", "poll-success"]);

    // Assert the authorize request carried offline_access.
    const authBody = String(fetchMock.mock.calls[0][1].body);
    expect(new URLSearchParams(authBody).get("scope")).toContain(
      "offline_access"
    );
  });

  test("access_denied surfaces a safe error", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        jsonResponse(200, {
          device_code: "d",
          user_code: "C",
          verification_uri: "https://example.com",
          expires_in: 600,
          interval: 5
        })
      )
      .mockImplementationOnce(async () =>
        jsonResponse(400, { error: "access_denied" })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      login({ clientId: "c", sleep: async () => {}, now: () => 1 }, new MemoryStore())
    ).rejects.toThrow(/cancelled or denied/);
  });
});

describe("refreshAccessToken", () => {
  test("rotates and persists access + refresh tokens", async () => {
    const store = new MemoryStore();
    store.session = {
      accessToken: "old",
      refreshToken: "old-refresh",
      connectedAt: "2026-01-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { access_token: "new", refresh_token: "new-refresh" })
      )
    );

    const token = await refreshAccessToken(store, { clientId: "c" });
    expect(token).toBe("new");
    expect(store.session.accessToken).toBe("new");
    expect(store.session.refreshToken).toBe("new-refresh");
  });

  test("keeps prior refresh token when WorkOS omits a rotated one", async () => {
    const store = new MemoryStore();
    store.session = {
      accessToken: "old",
      refreshToken: "keep-me",
      connectedAt: "2026-01-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { access_token: "new" }))
    );
    await refreshAccessToken(store, { clientId: "c" });
    expect(store.session.refreshToken).toBe("keep-me");
  });

  test("4xx triggers ReconnectRequiredError", async () => {
    const store = new MemoryStore();
    store.session = {
      accessToken: "old",
      refreshToken: "bad",
      connectedAt: "2026-01-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "invalid_grant" }))
    );
    await expect(refreshAccessToken(store, { clientId: "c" })).rejects.toBeInstanceOf(
      ReconnectRequiredError
    );
  });

  test("missing refresh token triggers ReconnectRequiredError without a network call", async () => {
    const store = new MemoryStore();
    store.session = { accessToken: "old", connectedAt: "x" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshAccessToken(store, { clientId: "c" })).rejects.toBeInstanceOf(
      ReconnectRequiredError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ensureAccessToken proactive refresh", () => {
  const now = 2_000;

  test("returns the stored token when comfortably valid (no network)", async () => {
    const store = new MemoryStore();
    store.session = {
      accessToken: jwtWithExp(now + 3_600),
      refreshToken: "r",
      connectedAt: "x"
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const token = await ensureAccessToken(store, { clientId: "c", now: () => now });
    expect(token).toBe(store.session.accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refreshes when the token is within the buffer", async () => {
    const store = new MemoryStore();
    store.session = {
      accessToken: jwtWithExp(now + 10), // within 60s buffer
      refreshToken: "r",
      connectedAt: "x"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { access_token: "fresh" }))
    );
    const token = await ensureAccessToken(store, { clientId: "c", now: () => now });
    expect(token).toBe("fresh");
  });

  test("throws ReconnectRequiredError when no session is stored", async () => {
    await expect(
      ensureAccessToken(new MemoryStore(), { clientId: "c" })
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});
