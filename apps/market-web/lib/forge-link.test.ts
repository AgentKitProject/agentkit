import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildRunInForgeWebLink, getForgeWebUrl } from "./forge-link.ts";

describe("forge web links", () => {
  it("builds a web Forge link with the market: slug", () => {
    const link = buildRunInForgeWebLink({ slug: "sales-report-generator" });

    assert.equal(link, "https://forge.agentkitproject.com/forge?kit=market%3Asales-report-generator");
  });

  it("can include a public-safe kit id without adding private data", () => {
    const link = buildRunInForgeWebLink({ slug: "sales-report-generator", kitId: "kit_public_123" });

    assert.match(link ?? "", /kit=market%3Asales-report-generator/);
    assert.match(link ?? "", /kitId=kit_public_123/);
    assert.doesNotMatch(link ?? "", /downloadUrl|packageS3Key|token|AGENTKITMARKET_ADMIN_KEY|submittedByEmail|submittedByUserId/);
  });

  it("hosted getForgeWebUrl points at web Forge (desktop retired)", () => {
    assert.equal(getForgeWebUrl(), "https://forge.agentkitproject.com");
  });

  it("renders the Open in Forge button as a web link, no desktop deep link or private fields", async () => {
    const source = await readFile(new URL("../components/OpenInForgeButton.tsx", import.meta.url), "utf8");

    assert.match(source, /Open in Forge/);
    assert.match(source, /buildRunInForgeWebLink/);
    assert.doesNotMatch(source, /agentkitforge:\/\/|buildForgeImportDeepLink|Forge not installed/);
    assert.doesNotMatch(source, /downloadUrl|packageS3Key|token|AGENTKITMARKET_ADMIN_KEY|submittedByEmail|submittedByUserId/);
  });
});
