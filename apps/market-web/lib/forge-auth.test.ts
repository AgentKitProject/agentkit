import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { getForgeAuthorizationDiagnostics, parseBearerToken, requireForgeUser } from "./forge-auth.ts";

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
    const address = server.address();

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
