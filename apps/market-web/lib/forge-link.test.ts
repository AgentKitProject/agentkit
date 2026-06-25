import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildForgeImportDeepLink, getForgeWebUrl } from "./forge-link.ts";

describe("forge import links", () => {
  it("builds a safe deep link with market base URL and slug", () => {
    const link = buildForgeImportDeepLink({
      marketBaseUrl: "https://market.agentkitproject.com/",
      slug: "sales-report-generator"
    });

    assert.equal(
      link,
      "agentkitforge://market/import?market=https%3A%2F%2Fmarket.agentkitproject.com&kit=sales-report-generator"
    );
  });

  it("can include a public-safe kit id without adding private data", () => {
    const link = buildForgeImportDeepLink({
      marketBaseUrl: "https://market.agentkitproject.com",
      slug: "sales-report-generator",
      kitId: "kit_public_123"
    });

    assert.match(link, /kit=sales-report-generator/);
    assert.match(link, /kitId=kit_public_123/);
    assert.doesNotMatch(link, /downloadUrl|packageS3Key|token|AGENTKITMARKET_ADMIN_KEY|submittedByEmail|submittedByUserId/);
  });

  it("renders the Open in Forge button and fallback link without private fields", async () => {
    const source = await readFile(new URL("../components/OpenInForgeButton.tsx", import.meta.url), "utf8");

    assert.match(source, /Open in Forge/);
    assert.match(source, /Forge not installed/);
    assert.match(source, /buildForgeImportDeepLink/);
    assert.equal(getForgeWebUrl(), "https://forge.agentkitproject.com");
    assert.doesNotMatch(source, /downloadUrl|packageS3Key|token|AGENTKITMARKET_ADMIN_KEY|submittedByEmail|submittedByUserId/);
  });
});
