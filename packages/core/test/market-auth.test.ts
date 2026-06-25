import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
  decodeJwtExp,
  isTokenExpired,
  tokenNeedsRefresh
} from "../src/market/jwt.js";
import {
  buildDeviceAuthorizationRequest,
  buildDeviceTokenRequest,
  buildRefreshTokenRequest,
  parseDeviceAuthorizationResponse,
  parseDeviceTokenResponse,
  WORKOS_DEVICE_AUTH_SCOPE
} from "../src/market/workos.js";
import { FileTokenStore } from "../src/market/store.js";
import type { StoredSession } from "../src/market/types.js";

/** Build a base64url (no-pad) JWT with the given exp; signature is bogus. */
function jwtWithExp(exp: number): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64url({ alg: "RS256" })}.${b64url({ sub: "user_1", exp })}.sig`;
}

describe("market jwt helpers", () => {
  test("decodeJwtExp extracts exp from a sample token", () => {
    expect(decodeJwtExp(jwtWithExp(1_900_000_000))).toBe(1_900_000_000);
  });

  test("decodeJwtExp returns null for malformed tokens", () => {
    expect(decodeJwtExp("not-a-jwt")).toBeNull();
    expect(decodeJwtExp("only.two")).toBeNull();
    expect(decodeJwtExp("")).toBeNull();
    // Valid base64url segment but not JSON.
    expect(decodeJwtExp("aaa.bm90LWpzb24.sig")).toBeNull();
  });

  test("tokenNeedsRefresh boundaries", () => {
    expect(tokenNeedsRefresh(1_000, 2_000, 60)).toBe(true); // expired
    expect(tokenNeedsRefresh(2_030, 2_000, 60)).toBe(true); // within buffer
    expect(tokenNeedsRefresh(2_060, 2_000, 60)).toBe(true); // exactly at boundary
    expect(tokenNeedsRefresh(2_061, 2_000, 60)).toBe(false); // just past boundary
    expect(tokenNeedsRefresh(5_000, 2_000, 60)).toBe(false); // comfortably valid
    expect(tokenNeedsRefresh(null, 2_000, 60)).toBe(true); // unknown exp
  });

  test("isTokenExpired uses the default buffer", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isTokenExpired(jwtWithExp(now - 600))).toBe(true);
    expect(
      isTokenExpired(jwtWithExp(now + 3_600), now, ACCESS_TOKEN_REFRESH_BUFFER_SECONDS)
    ).toBe(false);
  });
});

describe("workos request building", () => {
  test("device authorization request includes offline_access scope", () => {
    const req = buildDeviceAuthorizationRequest({ clientId: "client_abc" });
    const params = new URLSearchParams(req.body);
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(params.get("client_id")).toBe("client_abc");
    expect(params.get("scope")).toBe(WORKOS_DEVICE_AUTH_SCOPE);
    expect(params.get("scope")).toContain("offline_access");
  });

  test("device token request uses device_code grant", () => {
    const req = buildDeviceTokenRequest({ clientId: "c" }, "dev_123");
    const params = new URLSearchParams(req.body);
    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code"
    );
    expect(params.get("device_code")).toBe("dev_123");
    expect(params.get("client_id")).toBe("c");
  });

  test("refresh request uses refresh_token grant", () => {
    const req = buildRefreshTokenRequest({ clientId: "c" }, "refresh_xyz");
    const params = new URLSearchParams(req.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh_xyz");
  });

  test("parseDeviceAuthorizationResponse clamps interval", () => {
    const parsed = parseDeviceAuthorizationResponse({
      device_code: "d",
      user_code: "ABCD-1234",
      verification_uri: "https://example.com/device",
      verification_uri_complete: "https://example.com/device?code=ABCD-1234",
      expires_in: 600,
      interval: 1
    });
    expect(parsed.interval).toBe(5); // clamped up to minimum
    expect(parsed.userCode).toBe("ABCD-1234");
    expect(parsed.verificationUriComplete).toContain("code=");
  });

  test("parseDeviceTokenResponse maps user snake_case fields", () => {
    const parsed = parseDeviceTokenResponse({
      access_token: "at",
      refresh_token: "rt",
      user: { id: "u1", email: "a@b.c", first_name: "Ada", last_name: "Lovelace" }
    });
    expect(parsed.accessToken).toBe("at");
    expect(parsed.refreshToken).toBe("rt");
    expect(parsed.user?.firstName).toBe("Ada");
    expect(parsed.user?.lastName).toBe("Lovelace");
  });

  test("parseDeviceTokenResponse throws without an access token", () => {
    expect(() => parseDeviceTokenResponse({ refresh_token: "rt" })).toThrow();
  });
});

describe("FileTokenStore (file fallback, keyring disabled)", () => {
  async function withTempStore(
    run: (store: FileTokenStore, dir: string) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "akf-market-"));
    try {
      await run(new FileTokenStore({ dir, useKeyring: false }), dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const sample: StoredSession = {
    accessToken: "access-123",
    refreshToken: "refresh-456",
    user: { id: "u1", email: "a@b.c" },
    connectedAt: "2026-06-13T00:00:00.000Z"
  };

  test("set/get round-trip", async () => {
    await withTempStore(async (store) => {
      expect(await store.get()).toBeNull();
      await store.set(sample);
      const loaded = await store.get();
      expect(loaded).toEqual(sample);
    });
  });

  test("clear removes the session", async () => {
    await withTempStore(async (store) => {
      await store.set(sample);
      await store.clear();
      expect(await store.get()).toBeNull();
      // clear is idempotent
      await store.clear();
    });
  });

  test("session file is written with 0600 perms", async () => {
    if (process.platform === "win32") return; // perms not POSIX on Windows
    await withTempStore(async (store, dir) => {
      await store.set(sample);
      const info = await stat(path.join(dir, "session.json"));
      expect(info.mode & 0o777).toBe(0o600);
    });
  });

  test("empty access token is treated as no session", async () => {
    await withTempStore(async (store) => {
      await store.set({ ...sample, accessToken: "   " });
      expect(await store.get()).toBeNull();
    });
  });
});

describe("FileTokenStore keyring-absent path falls back to file", () => {
  test("default useKeyring still works when @napi-rs/keyring is not installed", async () => {
    // The optional native module is not a dependency here; the store must load
    // and persist via the file fallback without throwing.
    const dir = await mkdtemp(path.join(os.tmpdir(), "akf-market-kr-"));
    try {
      const store = new FileTokenStore({ dir }); // useKeyring defaults to true
      const sample: StoredSession = {
        accessToken: "access-789",
        connectedAt: "2026-06-13T00:00:00.000Z"
      };
      await store.set(sample);
      expect(await store.get()).toEqual(sample);
      await store.clear();
      expect(await store.get()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
