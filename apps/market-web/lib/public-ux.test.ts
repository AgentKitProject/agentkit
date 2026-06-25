import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("public UX polish", () => {
  it("homepage includes public preview, submit, trust, account, and Forge entry points", async () => {
    const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

    assert.match(source, /Browse kits/);
    assert.match(source, /Submit a kit/);
    assert.match(source, /AgentKitProject account/);
    assert.match(source, /AgentKitForge coming soon/);
    assert.match(source, /Trust and safety/);
    assert.match(source, /Report this listing/);
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

  it("footer renders support, report, legal, and AgentKitProject product links", async () => {
    // Chrome now renders via the shared @agentkitforge/ui SiteShell/Footer.
    // SiteChrome owns the Market brand title + the "Report a listing" link and
    // wires the framework's DEFAULT_FOOTER_LINKS (ecosystem + legal columns).
    const chrome = await readFile(new URL("../components/SiteChrome.tsx", import.meta.url), "utf8");
    const fwFooter = await readFile(
      new URL("../node_modules/@agentkitforge/ui/dist/components/Footer.js", import.meta.url),
      "utf8"
    );

    // App-owned footer content.
    assert.match(chrome, /AgentKitMarket/);
    assert.match(chrome, /Report a listing/);
    assert.match(chrome, /DEFAULT_FOOTER_LINKS/);

    // Shared ecosystem + legal links provided by the framework footer.
    assert.match(fwFooter, /Terms/);
    assert.match(fwFooter, /Privacy/);
    assert.match(fwFooter, /Security/);
    assert.match(fwFooter, /AgentKitProject/);
    assert.match(fwFooter, /Roadmap/);
    assert.match(fwFooter, /agentkitproject\.com\/roadmap/);
    assert.match(fwFooter, /Forge/);
    assert.match(fwFooter, /Account/);
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
