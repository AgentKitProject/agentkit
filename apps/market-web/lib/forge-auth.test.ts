import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  __resetForgeOidcCacheForTest,
  getForgeAuthorizationDiagnostics,
  parseBearerToken,
  requireForgeUser
} from "./forge-auth.ts";

describe("forge auth", () => {
  it("extracts bearer tokens from authorization headers", () => {
    assert.equal(parseBearerToken("Bearer token_123"), "token_123");
    assert.equal(parseBearerToken("bearer token_456"), "token_456");
    assert.equal(parseBearerToken("  Bearer   token_789  "), "token_789");
  });

  it("rejects missing or non-bearer authorization headers", () => {
    assert.equal(parseBearerToken(null), null);
    assert.equal(parseBearerToken(""), null);
    assert.equal(parseBearerToken("Basic token_123"), null);
  });

  it("reports safe authorization diagnostics without token values", () => {
    assert.deepEqual(getForgeAuthorizationDiagnostics(null), {
      authorizationHeaderPresent: false,
      tokenLength: 0,
      failureStage: "missing_header"
    });
    assert.deepEqual(getForgeAuthorizationDiagnostics("Basic abc"), {
      authorizationHeaderPresent: true,
      tokenLength: 0,
      failureStage: "malformed_header"
    });
    assert.deepEqual(getForgeAuthorizationDiagnostics("Bearer abcdef"), {
      authorizationHeaderPresent: true,
      tokenLength: 6,
      failureStage: "token_verification_failed"
    });
  });

  it("does not require a browser session id claim for Forge device tokens", async () => {
    const source = await readFile(new URL("./forge-auth.ts", import.meta.url), "utf8");

    assert.match(source, /export async function requireForgeUser/);
    assert.match(source, /sessionId: stringClaim\(payload\.sid\)/);
    assert.doesNotMatch(source, /Missing token session/);
  });

  it("accepts a verified Forge-style bearer token without a browser session id", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "forge-test-key";
    const publicJwk = await exportJWK(publicKey);
    const jwks = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };
    const server = await startJwksServer(jwks);
    const address = server.address() as { port: number };

    assert.equal(typeof address, "object");
    assert.ok(address);

    const previousClientId = process.env.WORKOS_CLIENT_ID;
    const previousHostname = process.env.WORKOS_API_HOSTNAME;
    const previousHttps = process.env.WORKOS_API_HTTPS;
    const previousPort = process.env.WORKOS_API_PORT;

    process.env.WORKOS_CLIENT_ID = `forge-test-client-${address.port}`;
    process.env.WORKOS_API_HOSTNAME = `127.0.0.1:${address.port}`;
    process.env.WORKOS_API_HTTPS = "false";
    delete process.env.WORKOS_API_PORT;

    try {
      const token = await new SignJWT({ email: "forge@example.com" })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("user_forge_device")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const user = await requireForgeUser(new Request("https://market.test/api/forge/probe", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      }));

      assert.deepEqual(user, {
        id: "user_forge_device",
        email: "forge@example.com",
        sessionId: undefined
      });
    } finally {
      restoreEnv("WORKOS_CLIENT_ID", previousClientId);
      restoreEnv("WORKOS_API_HOSTNAME", previousHostname);
      restoreEnv("WORKOS_API_HTTPS", previousHttps);
      restoreEnv("WORKOS_API_PORT", previousPort);
      await closeServer(server);
    }
  });
});

describe("forge auth — OIDC (self-hosted) bearer verification", () => {
  const OIDC_ENV_KEYS = ["AUTH_PROVIDER", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_FORGE_AUDIENCE"] as const;

  async function withOidcHarness(
    run: (ctx: {
      issuer: string;
      audience: string;
      sign: (claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expired?: boolean }) => Promise<string>;
    }) => Promise<void>,
    envOverrides: Partial<Record<(typeof OIDC_ENV_KEYS)[number], string>> = {}
  ) {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "oidc-test-key";
    const publicJwk = await exportJWK(publicKey);
    const jwks = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };

    const previous: Record<string, string | undefined> = {};
    for (const key of OIDC_ENV_KEYS) previous[key] = process.env[key];

    const server = await startOidcServer(jwks, (port) => `http://127.0.0.1:${port}`);
    const address = server.address() as { port: number };
    assert.equal(typeof address, "object");
    assert.ok(address && typeof address === "object");
    const issuer = `http://127.0.0.1:${address.port}`;
    const clientId = "forge-desktop-client";

    process.env.AUTH_PROVIDER = "oidc";
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_CLIENT_ID = clientId;
    delete process.env.OIDC_FORGE_AUDIENCE;
    for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
    __resetForgeOidcCacheForTest();

    const audience = process.env.OIDC_FORGE_AUDIENCE ?? clientId;

    const sign = (
      claims: Record<string, unknown>,
      opts: { issuer?: string; audience?: string; expired?: boolean } = {}
    ) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(opts.issuer ?? issuer)
        .setAudience(opts.audience ?? audience)
        .setIssuedAt();
      if (opts.expired) {
        jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60);
      } else {
        jwt.setExpirationTime("5m");
      }
      return jwt.sign(privateKey);
    };

    try {
      await run({ issuer, audience, sign });
    } finally {
      for (const key of OIDC_ENV_KEYS) restoreEnv(key, previous[key]);
      __resetForgeOidcCacheForTest();
      await closeServer(server);
    }
  }

  function forgeRequest(token: string): Request {
    return new Request("https://self-host.test/api/forge/probe", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
  }

  it("accepts a valid OIDC token and maps { id, email, sessionId }", async () => {
    await withOidcHarness(async ({ sign }) => {
      const token = await sign({ sub: "oidc_user_1", email: "self@host.test", sid: "oidc_sess" });
      const user = await requireForgeUser(forgeRequest(token));
      assert.deepEqual(user, { id: "oidc_user_1", email: "self@host.test", sessionId: "oidc_sess" });
    });
  });

  it("tolerates absent optional claims (email/sid)", async () => {
    await withOidcHarness(async ({ sign }) => {
      const token = await sign({ sub: "oidc_user_only" });
      const user = await requireForgeUser(forgeRequest(token));
      assert.deepEqual(user, { id: "oidc_user_only", email: undefined, sessionId: undefined });
    });
  });

  it("honors OIDC_FORGE_AUDIENCE override for the expected audience", async () => {
    await withOidcHarness(
      async ({ sign }) => {
        const token = await sign({ sub: "oidc_user_aud" }, { audience: "custom-forge-aud" });
        const user = await requireForgeUser(forgeRequest(token));
        assert.equal(user.id, "oidc_user_aud");
      },
      { OIDC_FORGE_AUDIENCE: "custom-forge-aud" }
    );
  });

  it("rejects a token with the wrong issuer (401)", async () => {
    await withOidcHarness(async ({ sign }) => {
      const token = await sign({ sub: "x" }, { issuer: "https://evil.example" });
      const error = await requireForgeUser(forgeRequest(token)).catch((e) => e);
      assert.equal(error.code, "INVALID_TOKEN");
      assert.equal(error.status, 401);
    });
  });

  it("rejects a token with the wrong audience (401)", async () => {
    await withOidcHarness(async ({ sign }) => {
      const token = await sign({ sub: "x" }, { audience: "some-other-client" });
      const error = await requireForgeUser(forgeRequest(token)).catch((e) => e);
      assert.equal(error.code, "INVALID_TOKEN");
      assert.equal(error.status, 401);
    });
  });

  it("rejects a token missing sub (401)", async () => {
    await withOidcHarness(async ({ sign }) => {
      const token = await sign({ email: "no-sub@host.test" });
      const error = await requireForgeUser(forgeRequest(token)).catch((e) => e);
      assert.equal(error.code, "INVALID_TOKEN");
      assert.equal(error.status, 401);
    });
  });

  it("rejects an expired token (401)", async () => {
    await withOidcHarness(async ({ sign }) => {
      const token = await sign({ sub: "expired_user" }, { expired: true });
      const error = await requireForgeUser(forgeRequest(token)).catch((e) => e);
      assert.equal(error.code, "INVALID_TOKEN");
      assert.equal(error.status, 401);
    });
  });

  it("returns SERVER_CONFIG_ERROR (500) when OIDC_ISSUER is unset", async () => {
    const prevProvider = process.env.AUTH_PROVIDER;
    const prevIssuer = process.env.OIDC_ISSUER;
    const prevClient = process.env.OIDC_CLIENT_ID;
    process.env.AUTH_PROVIDER = "oidc";
    delete process.env.OIDC_ISSUER;
    process.env.OIDC_CLIENT_ID = "c";
    __resetForgeOidcCacheForTest();
    try {
      const error = await requireForgeUser(
        new Request("https://self-host.test/api/forge/probe", {
          method: "POST",
          headers: { authorization: "Bearer whatever" }
        })
      ).catch((e) => e);
      assert.equal(error.code, "SERVER_CONFIG_ERROR");
      assert.equal(error.status, 500);
    } finally {
      restoreEnv("AUTH_PROVIDER", prevProvider);
      restoreEnv("OIDC_ISSUER", prevIssuer);
      restoreEnv("OIDC_CLIENT_ID", prevClient);
      __resetForgeOidcCacheForTest();
    }
  });
});

function startJwksServer(jwks: unknown) {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/sso/jwks/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(jwks));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "Not found" }));
  });

  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

// Serves both the OIDC discovery document and the JWKS. The discovery doc
// advertises a `jwks_uri` derived from the live server port, exercising the
// IdP-agnostic discovery path (no hardcoded Keycloak certs endpoint).
function startOidcServer(jwks: unknown, originForPort: (port: number) => string) {
  const server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    const origin = originForPort(port);
    if (request.url === "/.well-known/openid-configuration") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          issuer: origin,
          jwks_uri: `${origin}/oidc/jwks`
        })
      );
      return;
    }
    if (request.url === "/oidc/jwks") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(jwks));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "Not found" }));
  });

  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") {
    process.env[key] = value;
    return;
  }

  delete process.env[key];
}
