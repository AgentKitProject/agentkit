// lib/forge-auth.ts — Forge device-auth (bearer) verification.
//
// Verifies the WorkOS access-token bearer path used by NON-browser clients
// (desktop / CLI / Auto). We mock `jose` so no network JWKS fetch happens:
//   - jwtVerify resolves a payload  → authenticated user mapped from claims
//   - jwtVerify rejects             → INVALID_TOKEN (401)
//   - no / malformed Authorization  → NOT_SIGNED_IN (401)
//   - missing client id env         → SERVER_CONFIG_ERROR (500)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jwtVerifyMock = vi.fn<(token: string, key: unknown) => Promise<{ payload: Record<string, unknown> }>>();
const createRemoteJWKSetMock = vi.fn<(url: URL) => string>(() => "JWKS_HANDLE");

vi.mock("jose", () => ({
  jwtVerify: (token: string, key: unknown) => jwtVerifyMock(token, key),
  createRemoteJWKSet: (url: URL) => createRemoteJWKSetMock(url)
}));

import {
  requireForgeUser,
  ForgeAuthError,
  parseBearerToken,
  __resetForgeJwksCacheForTest
} from "@/lib/forge-auth";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jwtVerifyMock.mockReset();
  createRemoteJWKSetMock.mockClear();
  __resetForgeJwksCacheForTest();
  process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID = "client_test_123";
  delete process.env.WORKOS_API_HOSTNAME;
  delete process.env.WORKOS_API_HTTPS;
  delete process.env.WORKOS_API_PORT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function reqWithAuth(value?: string): Request {
  const headers = new Headers();
  if (value !== undefined) headers.set("authorization", value);
  return new Request("https://forge.example/api/forge/gateway/sessions", {
    method: "POST",
    headers
  });
}

describe("requireForgeUser (WorkOS bearer JWT via mocked JWKS)", () => {
  it("returns the user id + claims for a valid token", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "user_abc", email: "dev@example.com", sid: "sess_xyz" }
    });

    const user = await requireForgeUser(reqWithAuth("Bearer good.token.here"));
    expect(user).toEqual({ id: "user_abc", email: "dev@example.com", sessionId: "sess_xyz" });

    // JWKS URL points at the device-flow client id.
    const url = createRemoteJWKSetMock.mock.calls[0][0] as URL;
    expect(url.href).toBe("https://api.workos.com/sso/jwks/client_test_123");
    // The token (not the header) is passed to jwtVerify.
    expect(jwtVerifyMock).toHaveBeenCalledWith("good.token.here", "JWKS_HANDLE");
  });

  it("omits optional claims when absent", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_only" } });
    const user = await requireForgeUser(reqWithAuth("Bearer t"));
    expect(user).toEqual({ id: "user_only" });
  });

  it("throws NOT_SIGNED_IN (401) when the Authorization header is missing", async () => {
    await expect(requireForgeUser(reqWithAuth())).rejects.toMatchObject({
      code: "NOT_SIGNED_IN",
      status: 401
    });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("throws NOT_SIGNED_IN (401) for a malformed (non-Bearer) header", async () => {
    await expect(requireForgeUser(reqWithAuth("Basic abc"))).rejects.toMatchObject({
      code: "NOT_SIGNED_IN",
      status: 401
    });
  });

  it("throws INVALID_TOKEN (401) when jose rejects the token", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("signature verification failed"));
    await expect(requireForgeUser(reqWithAuth("Bearer bad"))).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      status: 401
    });
  });

  it("throws INVALID_TOKEN (401) when the token has no sub claim", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { email: "x@y.z" } });
    await expect(requireForgeUser(reqWithAuth("Bearer t"))).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      status: 401
    });
  });

  it("throws SERVER_CONFIG_ERROR (500) when no WorkOS client id is configured", async () => {
    delete process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID;
    delete process.env.WORKOS_CLIENT_ID;
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_abc" } });
    await expect(requireForgeUser(reqWithAuth("Bearer t"))).rejects.toMatchObject({
      code: "SERVER_CONFIG_ERROR",
      status: 500
    });
  });

  it("falls back to WORKOS_CLIENT_ID when the device-flow client id is unset", async () => {
    delete process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID;
    process.env.WORKOS_CLIENT_ID = "fallback_client";
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_abc" } });
    await requireForgeUser(reqWithAuth("Bearer t"));
    const url = createRemoteJWKSetMock.mock.calls[0][0] as URL;
    expect(url.href).toBe("https://api.workos.com/sso/jwks/fallback_client");
  });
});

describe("parseBearerToken", () => {
  it("extracts the token from a Bearer header (case-insensitive)", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer  xyz ")).toBe("xyz");
  });
  it("returns null for missing / malformed headers", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
  });
});

describe("ForgeAuthError", () => {
  it("carries the HTTP status + diagnostics", () => {
    const err = new ForgeAuthError("NOT_SIGNED_IN", "nope", 401, {
      failureStage: "missing_header"
    });
    expect(err.status).toBe(401);
    expect(err.failureStage).toBe("missing_header");
  });
});
