import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildForgeUploadBackendRequest, validateForgeUploadBackendRequest } from "./forge-submission-payload.ts";

describe("forge submissions", () => {
  it("builds the backend upload body with derived identity only", () => {
    const payload = buildForgeUploadBackendRequest({
      request: {
        fileName: " example.agentkit.zip ",
        version: " 1.0.0 ",
        publisherId: "Fake Publisher",
        kitId: "kit_fake",
        slug: "fake-slug",
        kitSlug: "fake-kit-slug",
        submittedByUserId: "fake_user",
        submittedByEmail: "fake@example.com",
        publisherSnapshot: { displayName: "Fake" },
        listingDraft: {
          name: " Example Kit ",
          summary: " Short public summary ",
          description: " Optional longer description ",
          categories: [" Finance ", ""],
          tags: ["analytics"]
        }
      },
      userId: "user_real",
      email: "real@example.com",
      publisherSnapshot: {
        displayName: "Real User",
        handle: "real-user",
        avatarInitials: "RU",
        verified: false
      }
    });

    assert.deepEqual(payload, {
      fileName: "example.agentkit.zip",
      version: "1.0.0",
      publisherId: "Real User",
      submittedByUserId: "user_real",
      submittedByEmail: "real@example.com",
      publisherSnapshot: {
        displayName: "Real User",
        handle: "real-user",
        avatarInitials: "RU",
        verified: false
      },
      listingDraft: {
        name: "Example Kit",
        summary: "Short public summary",
        description: "Optional longer description",
        categories: ["Finance"],
        tags: ["analytics"]
      }
    });
    assert.equal(payload.publisherId, "Real User");
    assert.equal(JSON.stringify(payload).includes("Fake Publisher"), false);
    assert.equal(JSON.stringify(payload).includes("kit_fake"), false);
    assert.equal(JSON.stringify(payload).includes("fake-slug"), false);
    assert.equal(JSON.stringify(payload).includes("fake-kit-slug"), false);
    assert.equal(validateForgeUploadBackendRequest(payload), null);
  });

  it("requires canonical account email after Forge account resolution", () => {
    const payload = buildForgeUploadBackendRequest({
      request: {
        fileName: "example.agentkit.zip",
        version: "1.0.0",
        listingDraft: {
          name: "Example Kit",
          summary: "Short public summary",
          categories: [],
          tags: []
        }
      },
      userId: "user_real",
      publisherSnapshot: {
        displayName: null,
        handle: null,
        avatarInitials: "AK",
        verified: false
      }
    });

    assert.equal(payload.submittedByUserId, "user_real");
    assert.equal(payload.publisherId, "");
    assert.equal(payload.submittedByEmail, "");
    assert.equal(validateForgeUploadBackendRequest(payload), "AgentKitProfile display name is required for Market submission.");
  });

  it("uses Forge auth, derived identity, and clean JSON errors for upload and validate", async () => {
    const uploadRoute = await readFile(new URL("../app/api/forge/submissions/upload-url/route.ts", import.meta.url), "utf8");
    const validateRoute = await readFile(
      new URL("../app/api/forge/submissions/[submissionId]/validate/route.ts", import.meta.url),
      "utf8"
    );
    const source = await readFile(new URL("./forge-submissions.ts", import.meta.url), "utf8");
    const errorSource = await readFile(new URL("./forge-route-errors.ts", import.meta.url), "utf8");
    const authSource = await readFile(new URL("./forge-auth.ts", import.meta.url), "utf8");

    assert.match(uploadRoute, /createForgeUploadUrl/);
    assert.match(validateRoute, /validateForgeSubmission/);
    assert.match(source, /requireForgeUser/);
    assert.match(source, /resolveForgeSubmissionAccount/);
    assert.match(source, /buildForgeUploadBackendRequest/);
    assert.match(source, /fetchAdminBackend/);
    assert.match(source, /marketBackendRoutes\.adminCreateUploadUrl\(\)/);
    assert.match(source, /getSubmissionById/);
    assert.match(source, /isOwnSubmission/);
    assert.match(source, /startValidation/);
    assert.match(source, /forgeSubmissionUser/);
    assert.match(authSource, /NOT_SIGNED_IN/);
    assert.match(authSource, /AgentKitProject sign-in is required\./);
    assert.match(errorSource, /Response\.json\(\{ code, error: code, message \}/);
    assert.match(errorSource, /FORGE_AUTH_FAILED/);
    assert.match(errorSource, /Forge device-auth token was not accepted by AgentKitMarket\./);
    assert.match(errorSource, /authHelper: "requireForgeUser"/);
    assert.match(errorSource, /failureStage: error\.failureStage/);
    assert.match(source, /BAD_REQUEST/);
    assert.match(errorSource, /CONFLICT/);
    assert.match(errorSource, /MARKET_CONFIG_ERROR/);
    assert.match(source, /MARKET_BACKEND_ERROR/);
    assert.match(errorSource, /PROFILE_INCOMPLETE/);
    assert.doesNotMatch(source, /getCurrentUser|requireUserForApi|withAuth/);
    assert.doesNotMatch(source, /AGENTKITMARKET_ADMIN_KEY|PROFILE_SERVICE_KEY|WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD/);
    assert.doesNotMatch(source, /packageS3Key/);
  });

  it("documents the Forge auth diagnostic response shape", async () => {
    const source = await readFile(new URL("./forge-route-errors.ts", import.meta.url), "utf8");

    assert.match(source, /function forgeAuthFailedError\(error: ForgeAuthError, endpointPath: string\)/);
    assert.match(source, /endpointPath/);
    assert.match(source, /authorizationHeaderPresent/);
    assert.match(source, /tokenLength/);
    assert.match(source, /authHelper: "requireForgeUser"/);
    assert.match(source, /failureStage: error\.failureStage/);
  });
});
