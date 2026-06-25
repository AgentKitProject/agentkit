import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { forgeMarketRoutes, profileRoutes } from "@agentkitforge/contracts";
import { getPublicProfileForUser } from "./profile/profile-client.ts";
import { validateForgeUploadBackendRequest, type ForgeUploadBackendRequest } from "./forge-submission-payload.ts";

describe("contracts integration", () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.PROFILE_API_BASE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.PROFILE_API_BASE_URL;
    } else {
      process.env.PROFILE_API_BASE_URL = originalBaseUrl;
    }
  });

  it("profile-client requests exactly the contract profile route", async () => {
    process.env.PROFILE_API_BASE_URL = "https://profile-api.example.com/prod";
    let requestedUrl: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          userId: "user_123",
          displayName: "Finance Builder",
          handle: "finance-builder",
          avatarInitials: "FB",
          verified: true
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    await getPublicProfileForUser("user 123/x");

    assert.equal(requestedUrl, `https://profile-api.example.com/prod${profileRoutes.publicByUserId("user 123/x")}`);
  });

  it("the shared forge upload fixture passes the app's payload validation", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "node_modules/@agentkitforge/contracts/fixtures/forge-upload-backend-request.json"
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ForgeUploadBackendRequest;

    assert.equal(validateForgeUploadBackendRequest(fixture), null);
  });

  it("a route file exists for every forgeMarketRoutes path", () => {
    const routeFiles: Record<keyof typeof forgeMarketRoutes, string> = {
      download: "app/api/forge/kits/[slug]/download/route.ts",
      kitDetail: "app/api/forge/kits/[slug]/route.ts",
      submissionUploadUrl: "app/api/forge/submissions/upload-url/route.ts",
      submissionValidate: "app/api/forge/submissions/[submissionId]/validate/route.ts",
      publisherProfile: "app/api/forge/publisher-profile/route.ts"
    };

    // Every contract route key must be covered by the mapping above.
    assert.deepEqual(Object.keys(routeFiles).sort(), Object.keys(forgeMarketRoutes).sort());

    for (const [key, file] of Object.entries(routeFiles)) {
      assert.ok(existsSync(path.join(process.cwd(), file)), `Missing route file for forgeMarketRoutes.${key}: ${file}`);
    }
  });
});
