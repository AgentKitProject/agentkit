// Instance-level require-login gate: env flag + pure decision logic.
//
// These exercise the PURE helpers (no Next runtime), matching the require-login
// design: REQUIRE_LOGIN=true gates every non-exempt request; default OFF keeps
// the catalog PUBLIC (hosted marketplace unaffected). The exempt list — /auth/*,
// /api/forge/* (+ /api/forge/service/*), /healthz — must always pass through so
// login, the device-bearer/service-key seams, and probes keep working.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  isRequireLoginExemptPath,
  requireLoginEnabled,
  requireLoginGateDecision,
  REQUIRE_LOGIN_EXEMPT_PREFIXES
} from "./require-login.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** A minimal env override carrying only REQUIRE_LOGIN, for the helper. */
function envWith(requireLogin: string): NodeJS.ProcessEnv {
  return { REQUIRE_LOGIN: requireLogin } as unknown as NodeJS.ProcessEnv;
}

describe("requireLoginEnabled", () => {
  it("is false when REQUIRE_LOGIN is unset on a hosted (non-self-host) instance", () => {
    assert.equal(
      requireLoginEnabled({} as unknown as NodeJS.ProcessEnv),
      false,
    );
  });

  it("is false for explicit falsey values (not 'true')", () => {
    for (const value of ["false", "FALSE", "  False  "]) {
      assert.equal(requireLoginEnabled(envWith(value)), false, value);
    }
  });

  it("is true for 'true' (case/space-insensitive), even on hosted", () => {
    for (const value of ["true", "TRUE", "  True  "]) {
      assert.equal(requireLoginEnabled(envWith(value)), true, value);
    }
  });

  it("defaults ON for self-host (SELF_HOST truthy) when REQUIRE_LOGIN is unset", () => {
    for (const env of [{ SELF_HOST: "true" }, { SELF_HOST: "1" }]) {
      assert.equal(
        requireLoginEnabled(env as unknown as NodeJS.ProcessEnv),
        true,
        JSON.stringify(env),
      );
    }
  });

  it("stays OFF for AUTH_PROVIDER=oidc alone (OIDC does not imply self-host)", () => {
    assert.equal(
      requireLoginEnabled({ AUTH_PROVIDER: "oidc" } as unknown as NodeJS.ProcessEnv),
      false,
    );
  });

  it("explicit REQUIRE_LOGIN=false wins even on self-host", () => {
    assert.equal(
      requireLoginEnabled({
        SELF_HOST: "true",
        REQUIRE_LOGIN: "false",
      } as unknown as NodeJS.ProcessEnv),
      false,
    );
  });
});

describe("isRequireLoginExemptPath", () => {
  it("exempts /auth/*, /api/forge/*, /api/forge/service/*, /healthz", () => {
    assert.equal(isRequireLoginExemptPath("/auth/sign-in"), true);
    assert.equal(isRequireLoginExemptPath("/auth/callback"), true);
    assert.equal(isRequireLoginExemptPath("/auth/sign-out"), true);
    assert.equal(isRequireLoginExemptPath("/api/forge/kits/x/download"), true);
    assert.equal(isRequireLoginExemptPath("/api/forge/service/anything"), true);
    assert.equal(isRequireLoginExemptPath("/healthz"), true);
  });

  it("does NOT exempt normal pages or non-forge API routes", () => {
    assert.equal(isRequireLoginExemptPath("/"), false);
    assert.equal(isRequireLoginExemptPath("/kits"), false);
    assert.equal(isRequireLoginExemptPath("/api/kits"), false);
    assert.equal(isRequireLoginExemptPath("/api/submissions/x"), false);
    // Not fooled by a lookalike that merely contains an exempt segment.
    assert.equal(isRequireLoginExemptPath("/blog/auth/intro"), false);
    assert.equal(isRequireLoginExemptPath("/healthzz"), true); // prefix match, acceptable
  });

  it("keeps the exempt prefixes a stable, documented set", () => {
    assert.deepEqual([...REQUIRE_LOGIN_EXEMPT_PREFIXES], [
      "/auth/",
      "/api/forge/",
      "/healthz"
    ]);
  });
});

describe("requireLoginGateDecision", () => {
  it("gate OFF → everything is allowed (public catalog)", () => {
    for (const pathname of ["/", "/kits", "/api/kits", "/admin"]) {
      assert.equal(
        requireLoginGateDecision({ enabled: false, pathname, authenticated: false }),
        "allow",
        pathname
      );
    }
  });

  it("gate ON + unauthenticated + normal page → redirect", () => {
    assert.equal(
      requireLoginGateDecision({ enabled: true, pathname: "/kits", authenticated: false }),
      "redirect"
    );
    assert.equal(
      requireLoginGateDecision({ enabled: true, pathname: "/", authenticated: false }),
      "redirect"
    );
  });

  it("gate ON + unauthenticated + /api/* → unauthorized (401)", () => {
    assert.equal(
      requireLoginGateDecision({ enabled: true, pathname: "/api/kits", authenticated: false }),
      "unauthorized"
    );
    assert.equal(
      requireLoginGateDecision({ enabled: true, pathname: "/api/submissions/x", authenticated: false }),
      "unauthorized"
    );
  });

  it("gate ON + exempt paths → allow even when unauthenticated", () => {
    for (const pathname of [
      "/auth/sign-in",
      "/auth/callback",
      "/api/forge/kits/x/download",
      "/api/forge/service/x",
      "/healthz"
    ]) {
      assert.equal(
        requireLoginGateDecision({ enabled: true, pathname, authenticated: false }),
        "allow",
        pathname
      );
    }
  });

  it("gate ON + authenticated → allow (pages and api alike)", () => {
    for (const pathname of ["/", "/kits", "/api/kits", "/admin"]) {
      assert.equal(
        requireLoginGateDecision({ enabled: true, pathname, authenticated: true }),
        "allow",
        pathname
      );
    }
  });
});
