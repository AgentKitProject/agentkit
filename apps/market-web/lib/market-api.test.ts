import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { isPublicCatalogKit, normalizeKitDetail } from "./market-api.ts";

describe("market-api public listing gate", () => {
  it("requires published status, passed validation, and approved review", () => {
    assert.equal(
      isPublicCatalogKit({
        status: "published",
        validationStatus: "passed",
        reviewStatus: "approved"
      }),
      true
    );

    assert.equal(
      isPublicCatalogKit({
        status: "draft",
        validationStatus: "passed",
        reviewStatus: "approved"
      }),
      false
    );

    assert.equal(
      isPublicCatalogKit({
        status: "published",
        validationStatus: "failed",
        reviewStatus: "approved"
      }),
      false
    );

    assert.equal(
      isPublicCatalogKit({
        status: "published",
        validationStatus: "passed",
        reviewStatus: "pending"
      }),
      false
    );
  });

  it("uses uncached catalog API fetches", async () => {
    const source = await readFile(new URL("./market-api.ts", import.meta.url), "utf8");

    assert.match(source, /cache:\s*"no-store"/);
    assert.doesNotMatch(source, /next:\s*\{\s*revalidate:/);
  });

  it("does not apply a duplicate frontend public-gate filter to the list response", async () => {
    const source = await readFile(new URL("./market-api.ts", import.meta.url), "utf8");
    const listKitsBody = source.slice(source.indexOf("export async function listKits"), source.indexOf("export async function getKitBySlug"));

    assert.doesNotMatch(listKitsBody, /\.filter\(isPublicCatalogKit\)/);
  });

  it("parses backend detail responses shaped as { item } with null optional fields", () => {
    const detail = normalizeKitDetail({
      item: {
        slug: "test-finance-analytics-kit",
        name: "Test Finance Analytics Kit",
        summary: "Analyzes finance data.",
        description: "Public-safe detail.",
        status: "published",
        validationStatus: "passed",
        reviewStatus: "approved",
        publisher: {
          displayName: null,
          publisherId: "publisher_finance"
        },
        categories: ["Finance"],
        tags: ["Analytics"],
        requiredInputs: [],
        preparedPrompts: [],
        skills: [],
        importUrl: null,
        downloadUrl: null
      }
    });

    assert.equal(detail.slug, "test-finance-analytics-kit");
    assert.equal(detail.name, "Test Finance Analytics Kit");
    assert.equal(detail.publisher.name, "AgentKit user");
    assert.equal(detail.publisher.slug, "publisher_finance");
    assert.equal(detail.publisher.initials, "AK");
    assert.deepEqual(detail.requiredInputs, []);
    assert.deepEqual(detail.preparedPrompts, []);
    assert.deepEqual(detail.skills, []);
  });

  it("does not expose raw user IDs or emails as public publisher names", () => {
    const detail = normalizeKitDetail({
      item: {
        slug: "identity-safe-kit",
        name: "Identity Safe Kit",
        summary: "Keeps identity safe.",
        publisher: {
          displayName: "user_user_01KT5C7TCF0VZHBBEQ1ZPRPGNE",
          handle: "owner@example.com",
          publisherId: "user_user_01KT5C7TCF0VZHBBEQ1ZPRPGNE"
        },
        categories: [],
        tags: [],
        requiredInputs: [],
        preparedPrompts: [],
        skills: []
      }
    });

    assert.equal(detail.publisher.name, "AgentKit user");
    assert.equal(detail.publisher.initials, "AK");
    assert.notEqual(detail.publisher.name, "user_user_01KT5C7TCF0VZHBBEQ1ZPRPGNE");
    assert.notEqual(detail.publisher.name, "owner@example.com");
  });

  it("uses safe public handles when no display name exists", () => {
    const detail = normalizeKitDetail({
      item: {
        slug: "handle-kit",
        name: "Handle Kit",
        summary: "Uses handle.",
        publisher: {
          displayName: null,
          handle: "finance-builder"
        },
        categories: [],
        tags: [],
        requiredInputs: [],
        preparedPrompts: [],
        skills: []
      }
    });

    assert.equal(detail.publisher.name, "finance-builder");
    assert.equal(detail.publisher.initials, "FB");
  });

  it("uses publisher avatar initials from profile snapshots", () => {
    const detail = normalizeKitDetail({
      item: {
        slug: "profile-kit",
        name: "Profile Kit",
        summary: "Uses Profile snapshot.",
        publisher: {
          displayName: "Finance Builder",
          handle: "finance-builder",
          avatarInitials: "PX",
          verified: true
        },
        categories: [],
        tags: [],
        requiredInputs: [],
        preparedPrompts: [],
        skills: []
      }
    });

    assert.equal(detail.publisher.name, "Finance Builder");
    assert.equal(detail.publisher.handle, "finance-builder");
    assert.equal(detail.publisher.initials, "PX");
    assert.equal(detail.publisher.verified, true);
  });

  it("normalizes public-safe package metadata without exposing S3 keys", () => {
    const detail = normalizeKitDetail({
      item: {
        slug: "metadata-kit",
        name: "Metadata Kit",
        summary: "Has package metadata.",
        publisher: {
          displayName: "Metadata Publisher"
        },
        currentVersion: "1.0.0",
        latestVersion: {
          fileName: "metadata-kit.agentkit.zip",
          packageSizeBytes: 24576,
          sha256: "abc123",
          packageS3Key: "private/packages/metadata-kit.agentkit.zip",
          publishedAt: "2026-06-02T00:00:00.000Z"
        },
        categories: [],
        tags: [],
        requiredInputs: [],
        preparedPrompts: [],
        skills: []
      }
    });

    assert.deepEqual(detail.packageMetadata, {
      fileName: "metadata-kit.agentkit.zip",
      packageSizeBytes: 24576,
      sha256: "abc123",
      publishedAt: "2026-06-02T00:00:00.000Z"
    });
    assert.equal(JSON.stringify(detail).includes("packageS3Key"), false);
  });

  it("fetches kit details by encoded slug", async () => {
    const source = await readFile(new URL("./market-api.ts", import.meta.url), "utf8");

    assert.equal(source.includes("requestJson(`/kits/${encodeURIComponent(slug)}`)"), true);
  });

  it("kit cards link to kit slug paths", async () => {
    const source = await readFile(new URL("../components/KitCard.tsx", import.meta.url), "utf8");

    assert.equal(source.includes("href={`/kits/${kit.slug}`}"), true);
    assert.doesNotMatch(source, /kitId/);
  });

  it("kit detail source keeps download and Forge import public-safe", async () => {
    const source = await readFile(new URL("../app/kits/[slug]/page.tsx", import.meta.url), "utf8");

    assert.match(source, /Sign in to download/);
    assert.match(source, /KitDownloadButton slug=\{slug\}/);
    assert.match(source, /OpenInForgeButton/);
    assert.match(source, /Open in AgentKitForge/);
    assert.match(source, /SHA-256/);
    assert.doesNotMatch(source, /downloadUrl/);
    assert.doesNotMatch(source, /packageS3Key/);
    assert.doesNotMatch(source, /submittedByEmail/);
    assert.doesNotMatch(source, /submittedByUserId/);
  });
});
