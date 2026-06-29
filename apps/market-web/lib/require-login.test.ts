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
  it("is false when REQUIRE_LOGIN is unset (public default)", () => {
    delete process.env.REQUIRE_LOGIN;
    assert.equal(requireLoginEnabled(), false);
  });

  it("is false for anything other than 'true'", () => {
    for (const value of ["false", "1", "yes", "on", "", "TRUEISH"]) {
      assert.equal(requireLoginEnabled(envWith(value)), false, value);
    }
  });

  it("is true for 'true' (case/space-insensitive)", () => {
    for (const value of ["true", "TRUE", "  True  "]) {
      assert.equal(requireLoginEnabled(envWith(value)), true, value);
    }
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
