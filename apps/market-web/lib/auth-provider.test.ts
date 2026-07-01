// Auth-provider abstraction: provider selection, OIDC claim/role mapping, and
// the OIDC-disablement of the WorkOS-bound device-auth (forge-auth) seam.
//
// These tests deliberately exercise only the PURE helpers (selection + claim
// mapping) and the forge-auth 501 guard, none of which need the Next runtime —
// so they load cleanly under `node --test`.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveAuthProviderId, isOidcProvider } from "./auth-provider/index.ts";
import { mapOidcClaims, resolveOidcRole } from "./auth-provider/oidc-config.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("auth-provider selection", () => {
  it("defaults to workos when AUTH_PROVIDER is unset", () => {
    delete process.env.AUTH_PROVIDER;
    assert.equal(resolveAuthProviderId(), "workos");
    assert.equal(isOidcProvider(), false);
  });

  it("defaults to workos for unknown values", () => {
    process.env.AUTH_PROVIDER = "saml";
    assert.equal(resolveAuthProviderId(), "workos");
    assert.equal(isOidcProvider(), false);
  });

  it("selects oidc when AUTH_PROVIDER=oidc (case/space insensitive)", () => {
    process.env.AUTH_PROVIDER = "  OIDC  ";
    assert.equal(resolveAuthProviderId(), "oidc");
    assert.equal(isOidcProvider(), true);
  });
});

describe("mapOidcClaims → CurrentUser", () => {
  it("maps sub/email and given/family names", () => {
    delete process.env.ADMIN_OIDC_GROUP;
    delete process.env.ADMIN_EMAILS;
    delete process.env.AGENTKITMARKET_ADMIN_EMAILS;
    const user = mapOidcClaims({
      sub: "abc-123",
      email: "jane@example.com",
      given_name: "Jane",
      family_name: "Doe"
    });
    assert.deepEqual(user, {
      id: "abc-123",
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      role: "user"
    });
  });

  it("falls back to preferred_username for email and splits `name`", () => {
    const user = mapOidcClaims({ sub: "s1", preferred_username: "user@idp", name: "Ada Lovelace" });
    assert.equal(user.email, "user@idp");
    assert.equal(user.firstName, "Ada");
    assert.equal(user.lastName, "Lovelace");
  });

  it("maps an empty (no-sub, no-email) claim set to an anonymous role", () => {
    const user = mapOidcClaims({});
    assert.deepEqual(user, { id: "", email: "", firstName: null, lastName: null, role: "anonymous" });
  });
});

describe("resolveOidcRole → admin gating (self-hosted)", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("grants admin via the ADMIN_OIDC_GROUP claim (groups array)", () => {
    process.env.ADMIN_OIDC_GROUP = "market-admins";
    delete process.env.ADMIN_EMAILS;
    delete process.env.AGENTKITMARKET_ADMIN_EMAILS;
    assert.equal(
      resolveOidcRole({ groups: ["users", "market-admins"] }, "x@example.com"),
      "admin"
    );
  });

  it("grants admin via the ADMIN_EMAILS allowlist (case-insensitive)", () => {
    delete process.env.ADMIN_OIDC_GROUP;
    process.env.ADMIN_EMAILS = "owner@example.com, boss@example.com";
    assert.equal(resolveOidcRole({}, "Boss@Example.com"), "admin");
  });

  it("falls back to AGENTKITMARKET_ADMIN_EMAILS when ADMIN_EMAILS is unset", () => {
    delete process.env.ADMIN_OIDC_GROUP;
    delete process.env.ADMIN_EMAILS;
    process.env.AGENTKITMARKET_ADMIN_EMAILS = "owner@example.com";
    assert.equal(resolveOidcRole({}, "owner@example.com"), "admin");
  });

  it("returns plain user when no admin signal matches", () => {
    process.env.ADMIN_OIDC_GROUP = "market-admins";
    process.env.ADMIN_EMAILS = "owner@example.com";
    assert.equal(resolveOidcRole({ groups: ["users"] }, "nobody@example.com"), "user");
  });

  it("returns anonymous for an empty email", () => {
    delete process.env.ADMIN_OIDC_GROUP;
    delete process.env.ADMIN_EMAILS;
    delete process.env.AGENTKITMARKET_ADMIN_EMAILS;
    assert.equal(resolveOidcRole({}, ""), "anonymous");
  });
});

describe("OIDC routes the device-auth seam to the OIDC verifier", () => {
  it("requireForgeUser enters the OIDC path (not 501) under AUTH_PROVIDER=oidc", async () => {
    // The full OIDC verification happy/failure paths are covered in
    // forge-auth.test.ts against a local JWKS server. Here we only assert the
    // branch: with OIDC selected but OIDC_ISSUER unconfigured, it surfaces a
    // SERVER_CONFIG_ERROR (500) — proving it no longer short-circuits to 501.
    process.env.AUTH_PROVIDER = "oidc";
    delete process.env.OIDC_ISSUER;
    const { requireForgeUser, ForgeAuthError } = await import("./forge-auth.ts");
    const request = new Request("https://self-host.example/api/forge/x", {
      headers: { authorization: "Bearer whatever" }
    });
    const error = await requireForgeUser(request).catch((e) => e);
    assert.ok(error instanceof ForgeAuthError);
    assert.equal(error.code, "SERVER_CONFIG_ERROR");
    assert.equal(error.status, 500);
    assert.notEqual(error.status, 501);
  });

  it("requireForgeUser still verifies the bearer token under workos (default)", async () => {
    delete process.env.AUTH_PROVIDER;
    const { requireForgeUser, ForgeAuthError } = await import("./forge-auth.ts");
    // No Authorization header → the WorkOS path rejects as NOT_SIGNED_IN (401),
    // proving it is NOT short-circuited to 501 on the hosted path.
    const request = new Request("https://market.example/api/forge/x");
    const error = await requireForgeUser(request).catch((e) => e);
    assert.ok(error instanceof ForgeAuthError);
    assert.equal(error.code, "NOT_SIGNED_IN");
    assert.equal(error.status, 401);
  });
});
