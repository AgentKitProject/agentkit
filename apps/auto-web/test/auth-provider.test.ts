// Auth-provider abstraction: provider selection, OIDC claim mapping, and the
// OIDC-disablement of the device-auth (forge-auth) + market-auth seams. Adapted
// from agentkitforge-web/test/auth-provider.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

// AuthKit pulls in `next/cache` which isn't resolvable in the bare vitest env;
// the workos provider only needs the module to LOAD here (we don't exercise its
// network paths), so stub the surface it imports.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
  getSignInUrl: vi.fn(),
  handleAuth: vi.fn(),
  saveSession: vi.fn(),
  authkitMiddleware: vi.fn(() => vi.fn())
}));

import { resolveAuthProviderId, getAuthProvider, isOidcProvider } from "@/lib/auth-provider";
import { mapOidcClaims } from "@/lib/auth-provider/oidc-config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("auth-provider selection", () => {
  it("defaults to workos when AUTH_PROVIDER is unset", () => {
    delete process.env.AUTH_PROVIDER;
    expect(resolveAuthProviderId()).toBe("workos");
    expect(getAuthProvider().id).toBe("workos");
    expect(isOidcProvider()).toBe(false);
  });

  it("defaults to workos for unknown values", () => {
    process.env.AUTH_PROVIDER = "saml";
    expect(resolveAuthProviderId()).toBe("workos");
    expect(getAuthProvider().id).toBe("workos");
  });

  it("selects oidc when AUTH_PROVIDER=oidc (case/space insensitive)", () => {
    process.env.AUTH_PROVIDER = "  OIDC  ";
    expect(resolveAuthProviderId()).toBe("oidc");
    expect(getAuthProvider().id).toBe("oidc");
    expect(isOidcProvider()).toBe(true);
  });
});

describe("mapOidcClaims → CurrentUser", () => {
  it("maps sub/email and given/family names", () => {
    const user = mapOidcClaims({
      sub: "abc-123",
      email: "jane@example.com",
      given_name: "Jane",
      family_name: "Doe"
    });
    expect(user).toEqual({
      id: "abc-123",
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe"
    });
  });

  it("falls back to preferred_username for email and splits `name`", () => {
    const user = mapOidcClaims({ sub: "s1", preferred_username: "user@idp", name: "Ada Lovelace" });
    expect(user.email).toBe("user@idp");
    expect(user.firstName).toBe("Ada");
    expect(user.lastName).toBe("Lovelace");
  });

  it("tolerates missing name claims", () => {
    const user = mapOidcClaims({ sub: "s2" });
    expect(user).toEqual({ id: "s2", email: "", firstName: null, lastName: null });
  });
});

describe("OIDC routes WorkOS-bound seams to the OIDC verifier", () => {
  it("requireForgeUser enters the OIDC path (not 501) under oidc", async () => {
    // Full OIDC verification happy/failure paths are covered in
    // forge-auth.test.ts (mocked jose + fetch). Here we only assert the branch:
    // with OIDC selected but OIDC_ISSUER unconfigured it surfaces
    // SERVER_CONFIG_ERROR (500) — no longer a 501 short-circuit — and never
    // touches the network.
    process.env.AUTH_PROVIDER = "oidc";
    delete process.env.OIDC_ISSUER;
    const { requireForgeUser, ForgeAuthError } = await import("@/lib/forge-auth");
    const request = new Request("https://self-host.example/api/forge/auto/runs", {
      headers: { authorization: "Bearer whatever" }
    });
    const err = await requireForgeUser(request).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeAuthError);
    expect(err).toMatchObject({
      name: "ForgeAuthError",
      code: "SERVER_CONFIG_ERROR",
      status: 500
    });
  });

  it("getWorkosAccessToken no-ops to null under oidc (no WorkOS call)", async () => {
    process.env.AUTH_PROVIDER = "oidc";
    const { getWorkosAccessToken } = await import("@/server/core/market-auth");
    expect(await getWorkosAccessToken()).toBeNull();
  });
});
