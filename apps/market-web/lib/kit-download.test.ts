import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { downloadErrorFallback, normalizeKitDownloadResponse } from "./kit-download.ts";

describe("kit download flow", () => {
  it("normalizes backend download URL responses", () => {
    const response = normalizeKitDownloadResponse({
      kitId: "kit_test",
      version: "1.2.3",
      downloadUrl: "https://example.com/private-download",
      expiresIn: 300,
      fileName: "kit-test.agentkit.zip",
      packageSizeBytes: 1024,
      sha256: "abc123"
    });

    assert.deepEqual(response, {
      kitId: "kit_test",
      version: "1.2.3",
      downloadUrl: "https://example.com/private-download",
      expiresIn: 300,
      fileName: "kit-test.agentkit.zip",
      packageSizeBytes: 1024,
      sha256: "abc123"
    });
  });

  it("uses user-friendly download error fallbacks", () => {
    assert.equal(downloadErrorFallback(401), "Sign in is required to download kits.");
    assert.equal(downloadErrorFallback(403), "This kit is not available for download.");
    assert.equal(downloadErrorFallback(404), "This kit is unavailable.");
    assert.equal(downloadErrorFallback(502), "Downloads are temporarily unavailable.");
  });

  it("proxies downloads through the backend by-slug admin route", async () => {
    const source = await readFile(new URL("../app/api/kits/[slug]/download/route.ts", import.meta.url), "utf8");

    assert.match(source, /requireUserForApi/);
    assert.match(source, /fetchAdminBackend/);
    assert.match(source, /\/admin\/kits\/by-slug\/\$\{encodeURIComponent\(slug\)\}\/download-url/);
  });

  it("proxies Forge downloads through bearer auth and the server-side backend route", async () => {
    const source = await readFile(new URL("../app/api/forge/kits/[slug]/download/route.ts", import.meta.url), "utf8");
    const forgeUploadRoute = await readFile(new URL("../app/api/forge/submissions/upload-url/route.ts", import.meta.url), "utf8");
    const forgeValidateRoute = await readFile(
      new URL("../app/api/forge/submissions/[submissionId]/validate/route.ts", import.meta.url),
      "utf8"
    );
    const forgeSubmissionSource = await readFile(new URL("./forge-submissions.ts", import.meta.url), "utf8");
    const authSource = await readFile(new URL("./forge-auth.ts", import.meta.url), "utf8");

    assert.match(source, /requireForgeUser/);
    assert.match(forgeUploadRoute, /createForgeUploadUrl/);
    assert.match(forgeValidateRoute, /validateForgeSubmission/);
    assert.match(forgeSubmissionSource, /requireForgeUser/);
    assert.doesNotMatch(forgeSubmissionSource, /getCurrentUser|requireUserForApi|withAuth/);
    assert.match(source, /fetchAdminBackend/);
    assert.match(source, /\/admin\/kits\/by-slug\/\$\{encodeURIComponent\(slug\)\}\/download-url/);
    assert.match(authSource, /INVALID_TOKEN|NOT_SIGNED_IN/);
    assert.doesNotMatch(source, /AGENTKITMARKET_ADMIN_KEY/);
    assert.doesNotMatch(source, /packageS3Key|submittedByEmail|submittedByUserId/);
  });

  it("does not expose admin key or package object keys in the browser download component", async () => {
    const source = await readFile(new URL("../components/KitDownloadButton.tsx", import.meta.url), "utf8");

    assert.doesNotMatch(source, /AGENTKITMARKET_ADMIN_KEY/);
    assert.doesNotMatch(source, /packageS3Key/);
    assert.match(source, /\/api\/kits\/\$\{encodeURIComponent\(slug\)\}\/download/);
  });
});
