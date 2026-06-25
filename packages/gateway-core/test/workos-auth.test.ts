/**
 * Seam #2 — WorkOS bearer authentication for the managed gateway.
 *
 * Test-mode: an injected `verifyToken` (no real WorkOS / JWKS / network). Covers
 * a valid token → userId, a token missing `sub` → reject, a verification failure
 * → reject, and a missing/malformed Authorization header → reject. The token is
 * never logged.
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { makeWorkOsAuthenticate, parseBearerToken } from "../src/entrypoints/workos-auth.js";

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

describe("parseBearerToken", () => {
  it("extracts the bearer token", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(parseBearerToken("bearer    spaced")).toBe("spaced");
  });
  it("rejects missing / malformed headers", () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("Token abc")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
  });
});

describe("makeWorkOsAuthenticate", () => {
  it("resolves sub → userId on a verified token", async () => {
    const authenticate = makeWorkOsAuthenticate({
      verifyToken: async (token) => {
        expect(token).toBe("good-token");
        return { sub: "user_123" };
      },
    });
    await expect(authenticate(req("Bearer good-token"))).resolves.toBe("user_123");
  });

  it("rejects a token whose payload has no sub", async () => {
    const authenticate = makeWorkOsAuthenticate({
      verifyToken: async () => ({ email: "x@y.z" }),
    });
    await expect(authenticate(req("Bearer no-sub"))).resolves.toBeUndefined();
  });

  it("rejects when verification throws (bad/expired token)", async () => {
    const authenticate = makeWorkOsAuthenticate({
      verifyToken: async () => {
        throw new Error("signature verification failed");
      },
    });
    await expect(authenticate(req("Bearer bad"))).resolves.toBeUndefined();
  });

  it("rejects a missing / malformed Authorization header without calling verify", async () => {
    let called = false;
    const authenticate = makeWorkOsAuthenticate({
      verifyToken: async () => {
        called = true;
        return { sub: "u" };
      },
    });
    await expect(authenticate(req())).resolves.toBeUndefined();
    await expect(authenticate(req("Token nope"))).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});
