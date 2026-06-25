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

describe("OIDC disables WorkOS-bound seams", () => {
  it("requireForgeUser returns NOT_SUPPORTED (501) under oidc", async () => {
    process.env.AUTH_PROVIDER = "oidc";
    const { requireForgeUser, ForgeAuthError } = await import("@/lib/forge-auth");
    const request = new Request("https://self-host.example/api/forge/auto/runs", {
      headers: { authorization: "Bearer whatever" }
    });
    await expect(requireForgeUser(request)).rejects.toMatchObject({
      name: "ForgeAuthError",
      code: "NOT_SUPPORTED",
      status: 501
    });
    // Sanity: the thrown error is the typed ForgeAuthError.
    const err = await requireForgeUser(request).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeAuthError);
  });

  it("getWorkosAccessToken no-ops to null under oidc (no WorkOS call)", async () => {
    process.env.AUTH_PROVIDER = "oidc";
    const { getWorkosAccessToken } = await import("@/server/core/market-auth");
    expect(await getWorkosAccessToken()).toBeNull();
  });
});
