// lib/forge-auth.ts — Forge device-auth (bearer) verification.
//
// Verifies the WorkOS access-token bearer path used by NON-browser clients
// (desktop / CLI / Auto). We mock `jose` so no network JWKS fetch happens:
//   - jwtVerify resolves a payload  → authenticated user mapped from claims
//   - jwtVerify rejects             → INVALID_TOKEN (401)
//   - no / malformed Authorization  → NOT_SIGNED_IN (401)
//   - missing client id env         → SERVER_CONFIG_ERROR (500)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jwtVerifyMock =
  vi.fn<(token: string, key: unknown, options?: unknown) => Promise<{ payload: Record<string, unknown> }>>();
const createRemoteJWKSetMock = vi.fn<(url: URL) => string>(() => "JWKS_HANDLE");

vi.mock("jose", () => ({
  // Forward the (optional) verify options so the OIDC path's { issuer, audience }
  // is observable; the WorkOS path calls with two args (no options), which we
  // preserve so existing two-arg assertions still match.
  jwtVerify: (token: string, key: unknown, options?: unknown) =>
    options === undefined ? jwtVerifyMock(token, key) : jwtVerifyMock(token, key, options),
  createRemoteJWKSet: (url: URL) => createRemoteJWKSetMock(url)
}));

import {
  requireForgeUser,
  ForgeAuthError,
  parseBearerToken,
  __resetForgeJwksCacheForTest,
  __resetForgeOidcCacheForTest
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

describe("requireForgeUser (OIDC self-hosted bearer JWT)", () => {
  const ISSUER = "https://idp.self-host.test/realms/agentkit";
  const JWKS_URI = "https://idp.self-host.test/realms/agentkit/keys";
  let fetchSpy: ReturnType<typeof vi.fn> | undefined;

  beforeEach(() => {
    __resetForgeOidcCacheForTest();
    process.env.AUTH_PROVIDER = "oidc";
    process.env.OIDC_ISSUER = ISSUER;
    process.env.OIDC_CLIENT_ID = "forge-desktop-client";
    delete process.env.OIDC_FORGE_AUDIENCE;
    // Discovery: return an IdP-advertised jwks_uri (not a hardcoded Keycloak path).
    fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URI }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetForgeOidcCacheForTest();
  });

  it("verifies against the discovered JWKS with issuer + audience and maps claims", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "oidc_user", email: "self@host.test", sid: "sess_oidc" }
    });

    const user = await requireForgeUser(reqWithAuth("Bearer oidc.token.here"));
    expect(user).toEqual({ id: "oidc_user", email: "self@host.test", sessionId: "sess_oidc" });

    // Discovery was performed against the issuer's well-known document.
    const discoveryUrl = (fetchSpy!.mock.calls[0][0] as URL).toString();
    expect(discoveryUrl).toBe(`${ISSUER}/.well-known/openid-configuration`);
    // JWKS resolver built from the discovered jwks_uri (IdP-agnostic).
    const jwksUrl = createRemoteJWKSetMock.mock.calls[0][0] as URL;
    expect(jwksUrl.href).toBe(JWKS_URI);
    // Verification enforced issuer + audience (audience defaults to OIDC_CLIENT_ID).
    expect(jwtVerifyMock).toHaveBeenCalledWith("oidc.token.here", "JWKS_HANDLE", {
      issuer: ISSUER,
      audience: "forge-desktop-client"
    });
  });

  it("uses OIDC_FORGE_AUDIENCE when set (device-client audience override)", async () => {
    process.env.OIDC_FORGE_AUDIENCE = "device-cli-client";
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "u" } });
    await requireForgeUser(reqWithAuth("Bearer t"));
    expect(jwtVerifyMock).toHaveBeenCalledWith("t", "JWKS_HANDLE", {
      issuer: ISSUER,
      audience: "device-cli-client"
    });
  });

  it("omits optional claims when absent", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "only" } });
    const user = await requireForgeUser(reqWithAuth("Bearer t"));
    expect(user).toEqual({ id: "only" });
  });

  it("throws NOT_SIGNED_IN (401) when the Authorization header is missing", async () => {
    await expect(requireForgeUser(reqWithAuth())).rejects.toMatchObject({
      code: "NOT_SIGNED_IN",
      status: 401
    });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("throws INVALID_TOKEN (401) when jose rejects (wrong issuer/audience/expired)", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("unexpected \"iss\" claim value"));
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

  it("throws SERVER_CONFIG_ERROR (500) when OIDC_ISSUER is unset", async () => {
    delete process.env.OIDC_ISSUER;
    await expect(requireForgeUser(reqWithAuth("Bearer t"))).rejects.toMatchObject({
      code: "SERVER_CONFIG_ERROR",
      status: 500
    });
    // Never attempted discovery.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws SERVER_CONFIG_ERROR (500) when no audience is resolvable", async () => {
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_FORGE_AUDIENCE;
    await expect(requireForgeUser(reqWithAuth("Bearer t"))).rejects.toMatchObject({
      code: "SERVER_CONFIG_ERROR",
      status: 500
    });
  });

  it("still uses the WorkOS path when AUTH_PROVIDER is unset", async () => {
    delete process.env.AUTH_PROVIDER;
    process.env.AGENTKITPROJECT_WORKOS_CLIENT_ID = "client_test_123";
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "workos_user" } });
    await requireForgeUser(reqWithAuth("Bearer t"));
    // WorkOS JWKS URL, no OIDC discovery fetch.
    const url = createRemoteJWKSetMock.mock.calls[0][0] as URL;
    expect(url.href).toBe("https://api.workos.com/sso/jwks/client_test_123");
    expect(fetchSpy).not.toHaveBeenCalled();
    // WorkOS verification passes NO issuer/audience options.
    expect(jwtVerifyMock).toHaveBeenCalledWith("t", "JWKS_HANDLE");
  });
});
