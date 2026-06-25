import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { getForgePublisherProfile } from "./forge-publisher-profile.ts";

describe("forge publisher profile", () => {
  it("uses Forge bearer auth and the shared forge helpers", async () => {
    const route = await readFile(new URL("../app/api/forge/publisher-profile/route.ts", import.meta.url), "utf8");
    const source = await readFile(new URL("./forge-publisher-profile.ts", import.meta.url), "utf8");

    assert.match(route, /getForgePublisherProfile/);
    assert.match(source, /requireForgeUser/);
    assert.match(source, /getPublicProfileForUser/);
    assert.match(source, /forgeSubmissionException/);
    assert.doesNotMatch(source, /getCurrentUser|requireUser\b|requireUserForApi|requireAdminForApi/);
  });

  it("returns the public publisher snapshot for an authenticated Forge user", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const kid = "forge-profile-test-key";
    const publicJwk = await exportJWK(publicKey);
    const jwks = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };
    const server = await startStubServer(jwks, {
      "/profiles/user_forge_profile": {
        displayName: "Real User",
        handle: "real-user",
        avatarInitials: "RU",
        verified: true,
        email: "private@example.com",
        userId: "user_forge_profile"
      }
    });
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected the stub server to expose an address.");
    }

    const previousEnv = snapshotEnv();

    process.env.WORKOS_CLIENT_ID = `forge-profile-test-client-${address.port}`;
    process.env.WORKOS_API_HOSTNAME = `127.0.0.1:${address.port}`;
    process.env.WORKOS_API_HTTPS = "false";
    delete process.env.WORKOS_API_PORT;
    process.env.PROFILE_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.PROFILE_SERVICE_KEY;

    try {
      const token = await new SignJWT({ email: "forge@example.com" })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject("user_forge_profile")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const response = await getForgePublisherProfile(
        new Request("https://market.test/api/forge/publisher-profile", {
          method: "GET",
          headers: { authorization: `Bearer ${token}` }
        })
      );

      assert.equal(response.status, 200);

      const body = (await response.json()) as Record<string, unknown>;

      assert.deepEqual(body, {
        displayName: "Real User",
        handle: "real-user",
        avatarInitials: "RU",
        verified: true
      });
      assert.equal(JSON.stringify(body).includes("private@example.com"), false);
      assert.equal(JSON.stringify(body).includes("user_forge_profile"), false);
    } finally {
      restoreEnvSnapshot(previousEnv);
      await closeServer(server);
    }
  });

  it("returns the shared 401 forge auth failure shape without a bearer token", async () => {
    const previousEnv = snapshotEnv();

    process.env.WORKOS_CLIENT_ID = "forge-profile-test-client";

    try {
      const response = await getForgePublisherProfile(
        new Request("https://market.test/api/forge/publisher-profile", { method: "GET" })
      );

      assert.equal(response.status, 401);

      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(body.code, "FORGE_AUTH_FAILED");
      assert.equal(body.error, "FORGE_AUTH_FAILED");
      assert.equal(body.message, "Forge device-auth token was not accepted by AgentKitMarket.");
      assert.deepEqual(body.diagnostics, {
        endpointPath: "/api/forge/publisher-profile",
        authorizationHeaderPresent: false,
        tokenLength: 0,
        authHelper: "requireForgeUser",
        failureStage: "missing_header"
      });
    } finally {
      restoreEnvSnapshot(previousEnv);
    }
  });
});

function startStubServer(jwks: unknown, profiles: Record<string, unknown>) {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/sso/jwks/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(jwks));
      return;
    }

    const profile = request.url ? profiles[request.url] : undefined;

    if (profile) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(profile));
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

function snapshotEnv() {
  const keys = [
    "WORKOS_CLIENT_ID",
    "WORKOS_API_HOSTNAME",
    "WORKOS_API_HTTPS",
    "WORKOS_API_PORT",
    "PROFILE_API_BASE_URL",
    "PROFILE_SERVICE_KEY"
  ] as const;

  return keys.map((key) => [key, process.env[key]] as const);
}

function restoreEnvSnapshot(entries: ReadonlyArray<readonly [string, string | undefined]>) {
  for (const [key, value] of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
