import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("app security boundaries", () => {
  it("keeps private submission/package fields out of public kit UI sources", async () => {
    const publicSources = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/kits/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/kits/[slug]/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/api/forge/kits/[slug]/download/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/forge/submissions/upload-url/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/forge/submissions/[submissionId]/validate/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../components/CatalogExplorer.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/KitCard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/KitDownloadButton.tsx", import.meta.url), "utf8")
    ]);
    const source = publicSources.join("\n");

    assert.doesNotMatch(source, /submittedByEmail/);
    assert.doesNotMatch(source, /submittedByUserId/);
    assert.doesNotMatch(source, /packageS3Key/);
    assert.doesNotMatch(source, /AGENTKITMARKET_ADMIN_KEY|PROFILE_SERVICE_KEY|WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD/);
    assert.doesNotMatch(source, /x-agentkitmarket-admin-key/);
  });

  it("keeps admin/service key attachment in server-side helpers and routes", async () => {
    const adminApi = await readFile(new URL("./admin-api.ts", import.meta.url), "utf8");
    const downloadRoute = await readFile(new URL("../app/api/kits/[slug]/download/route.ts", import.meta.url), "utf8");
    const adminProxy = await readFile(new URL("./admin-proxy.ts", import.meta.url), "utf8");

    assert.match(adminApi, /x-agentkitmarket-admin-key/);
    assert.match(adminApi, /process\.env\.AGENTKITMARKET_ADMIN_KEY/);
    assert.match(downloadRoute, /requireUserForApi/);
    assert.match(downloadRoute, /fetchAdminBackend/);
    assert.match(adminProxy, /requireAdminForApi/);
  });

  it("protects user submission and admin cleanup API routes server-side", async () => {
    const userUploadRoute = await readFile(new URL("../app/api/submissions/upload-url/route.ts", import.meta.url), "utf8");
    const userListRoute = await readFile(new URL("../app/api/submissions/route.ts", import.meta.url), "utf8");
    const userCancelRoute = await readFile(new URL("../app/api/submissions/[submissionId]/cancel/route.ts", import.meta.url), "utf8");
    const userRemoveListingRoute = await readFile(new URL("../app/api/kits/[slug]/remove/route.ts", import.meta.url), "utf8");
    const removeSubmissionRoute = await readFile(
      new URL("../app/api/admin/submissions/[submissionId]/remove/route.ts", import.meta.url),
      "utf8"
    );
    const removeListingRoute = await readFile(new URL("../app/api/admin/kits/[kitId]/remove/route.ts", import.meta.url), "utf8");
    const unhideRoute = await readFile(new URL("../app/api/admin/kits/[kitId]/unhide/route.ts", import.meta.url), "utf8");
    const userProxy = await readFile(new URL("./user-lifecycle-proxy.ts", import.meta.url), "utf8");
    const forgeUploadRoute = await readFile(new URL("../app/api/forge/submissions/upload-url/route.ts", import.meta.url), "utf8");
    const forgeValidateRoute = await readFile(
      new URL("../app/api/forge/submissions/[submissionId]/validate/route.ts", import.meta.url),
      "utf8"
    );
    const forgeSubmitHelper = await readFile(new URL("./forge-submissions.ts", import.meta.url), "utf8");

    assert.match(userUploadRoute, /requireUserForApi/);
    assert.match(userUploadRoute, /buildUserUploadBackendRequest/);
    assert.match(userListRoute, /requireUserForApi/);
    assert.match(userListRoute, /filterOwnSubmissions/);
    assert.match(userCancelRoute, /proxyUserLifecyclePost/);
    assert.match(userRemoveListingRoute, /proxyUserLifecyclePost/);
    assert.match(userProxy, /requireUserForApi/);
    assert.match(userProxy, /buildUserLifecycleRequest/);
    assert.match(removeSubmissionRoute, /proxyAdminPost/);
    assert.match(removeListingRoute, /proxyAdminPost/);
    assert.match(unhideRoute, /proxyAdminPost/);
    assert.match(forgeUploadRoute, /createForgeUploadUrl/);
    assert.match(forgeValidateRoute, /validateForgeSubmission/);
    assert.match(forgeSubmitHelper, /requireForgeUser/);
    assert.match(forgeSubmitHelper, /buildForgeUploadBackendRequest/);
  });

  it("renders sign-out as full-page navigation only", async () => {
    const header = await readFile(new URL("../components/SiteChrome.tsx", import.meta.url), "utf8");
    // Sign-out handling now lives in the WorkOS auth provider (hosted path); the
    // route is a thin delegate. The full-page-navigation guard is unchanged.
    const signOutHandler = await readFile(
      new URL("../lib/auth-provider/workos-provider.ts", import.meta.url),
      "utf8"
    );

    // Sign-out must use a plain <a> (not next/link or router.push) so it performs
    // full-page navigation and hits the sign-out route handler rather than being
    // intercepted by the client-side router.
    assert.match(header, /<a\b[^>]*href="\/auth\/sign-out"[^>]*>/);
    assert.doesNotMatch(header, /<Link\b[^>]*href="\/auth\/sign-out"/);
    assert.doesNotMatch(header, /router\.push\([^)]*sign-out|fetch\([^)]*sign-out/);
    assert.match(signOutHandler, /NextResponse\.redirect/);
    assert.match(signOutHandler, /isPrefetchOrRscRequest/);
  });
});
