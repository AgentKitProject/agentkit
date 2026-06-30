// Auth-provider abstraction: provider selection + OIDC claim mapping.
//
// These tests exercise only the PURE helpers (selection + claim mapping), which
// don't need the Next runtime, so they load cleanly under `node --test`.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveAuthProviderId, isOidcProvider } from "../lib/auth-provider/index.ts";
import { mapOidcClaims } from "../lib/auth-provider/oidc-config.ts";

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

describe("mapOidcClaims → AgentKitUser", () => {
  it("maps sub/email and given/family names", () => {
    const user = mapOidcClaims({
      sub: "abc-123",
      email: "jane@example.com",
      given_name: "Jane",
      family_name: "Doe",
    });
    assert.deepEqual(user, {
      id: "abc-123",
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("falls back to preferred_username for email and splits `name`", () => {
    const user = mapOidcClaims({ sub: "s1", preferred_username: "user@idp", name: "Ada Lovelace" });
    assert.equal(user.email, "user@idp");
    assert.equal(user.firstName, "Ada");
    assert.equal(user.lastName, "Lovelace");
  });

  it("maps an empty claim set to a null-email, no-id user", () => {
    const user = mapOidcClaims({});
    assert.deepEqual(user, { id: "", email: null, firstName: null, lastName: null });
  });
});
