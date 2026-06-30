import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("public UX polish", () => {
  it("homepage routes to the catalog (Market is an app, not a marketing site)", async () => {
    // The marketing hero was removed when Market became a sidebar-shell app.
    // "/" now redirects to the catalog at /kits.
    const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

    assert.match(source, /redirect/);
    assert.match(source, /\/kits/);
  });

  it("catalog explorer supports search, category, tag, trust, and no-result states", async () => {
    const source = await readFile(new URL("../components/CatalogExplorer.tsx", import.meta.url), "utf8");

    assert.match(source, /Search/);
    assert.match(source, /Category/);
    assert.match(source, /Tag/);
    assert.match(source, /Trust/);
    assert.match(source, /No kits found/);
    assert.match(source, /Clear filters/);
  });

  it("app chrome renders the sidebar AppShell with Market brand and catalog nav", async () => {
    // Chrome now renders via the shared @agentkitforge/ui AppShell (sidebar
    // layout) instead of the marketing SiteShell + footer. It owns the Market
    // brand, the catalog/submit nav, and the account block.
    const chrome = await readFile(new URL("../components/SiteChrome.tsx", import.meta.url), "utf8");

    assert.match(chrome, /AppShell/);
    assert.match(chrome, /layout="app"/);
    assert.match(chrome, /AgentKitMarket/);
    // Core local nav tabs.
    assert.match(chrome, /Catalog/);
    assert.match(chrome, /Submit/);
    assert.match(chrome, /My Submissions/);
    // Docs is the single allowed external link; Forge/Auto cross-links are not.
    assert.match(chrome, /Docs/);
    assert.doesNotMatch(chrome, /Web Forge/);
  });

  it("public route sources do not render private fields or secrets", async () => {
    const sources = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/kits/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/kits/[slug]/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/CatalogExplorer.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/KitCard.tsx", import.meta.url), "utf8")
    ]);
    const publicSource = sources.join("\n");

    assert.doesNotMatch(publicSource, /submittedByEmail/);
    assert.doesNotMatch(publicSource, /submittedByUserId/);
    assert.doesNotMatch(publicSource, /packageS3Key/);
    assert.doesNotMatch(publicSource, /AGENTKITMARKET_ADMIN_KEY/);
    assert.doesNotMatch(publicSource, /PROFILE_SERVICE_KEY/);
    assert.doesNotMatch(publicSource, /WORKOS_API_KEY/);
    assert.doesNotMatch(publicSource, /WORKOS_COOKIE_PASSWORD/);
  });
});
