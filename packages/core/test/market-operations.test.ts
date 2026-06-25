import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  fieldsRequireMultipart,
  planPackageUpload,
  sha256Hex,
  buildMultipartBody
} from "../src/market/upload.js";
import {
  assembleProvenance,
  normalizeMarketIdentifier
} from "../src/market/download.js";
import { buildForgeUploadRequest } from "../src/market/submit.js";
import { normalizeMarketBaseUrl } from "../src/market/http.js";
import { extractAgentKitZip } from "../src/market/import.js";
import { createAgentKit } from "../src/init/create.js";
import { packageAgentKit } from "../src/package/packager.js";
import { readFile } from "node:fs/promises";
import { assertSafeRelativePath } from "../src/fs/safety.js";

const PRESIGNED_URL = "https://bucket.s3.amazonaws.com/upload/abc";

describe("empty-fields PUT-vs-multipart (regression)", () => {
  test("empty fields {} => binary PUT, NOT multipart", () => {
    expect(fieldsRequireMultipart({})).toBe(false);
    const plan = planPackageUpload({ uploadUrl: PRESIGNED_URL, fields: {} });
    expect(plan.kind).toBe("binary");
    if (plan.kind === "binary") {
      expect(plan.method).toBe("PUT");
      expect(plan.headers["Content-Type"]).toBe("application/zip");
    }
  });

  test("null/undefined fields => binary PUT", () => {
    expect(fieldsRequireMultipart(null)).toBe(false);
    expect(fieldsRequireMultipart(undefined)).toBe(false);
    expect(planPackageUpload({ uploadUrl: PRESIGNED_URL }).kind).toBe("binary");
  });

  test("non-empty string fields => multipart POST", () => {
    const fields = { key: "uploads/abc", policy: "xyz" };
    expect(fieldsRequireMultipart(fields)).toBe(true);
    const plan = planPackageUpload({ uploadUrl: PRESIGNED_URL, fields });
    expect(plan.kind).toBe("multipart");
    if (plan.kind === "multipart") {
      expect(plan.fields).toEqual(fields);
    }
  });

  test("fields with non-string values => NOT multipart", () => {
    expect(fieldsRequireMultipart({ a: "x", b: 1 } as Record<string, unknown>)).toBe(false);
  });

  test("explicit POST method with empty fields stays binary POST", () => {
    const plan = planPackageUpload({
      uploadUrl: PRESIGNED_URL,
      method: "POST",
      fields: {}
    });
    expect(plan.kind).toBe("binary");
    if (plan.kind === "binary") expect(plan.method).toBe("POST");
  });

  test("non-https upload URL is rejected", () => {
    expect(() =>
      planPackageUpload({ uploadUrl: "http://insecure/upload", fields: {} })
    ).toThrow(/HTTPS/);
  });

  test("respects a server-provided content-type header", () => {
    const plan = planPackageUpload({
      uploadUrl: PRESIGNED_URL,
      headers: { "content-type": "application/octet-stream" }
    });
    if (plan.kind === "binary") {
      expect(plan.headers["content-type"]).toBe("application/octet-stream");
      expect(plan.headers["Content-Type"]).toBeUndefined();
    }
  });
});

describe("sha256", () => {
  test("matches node crypto for a known buffer", () => {
    const buf = Buffer.from("hello agentkit", "utf8");
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(sha256Hex(buf)).toBe(expected);
    expect(sha256Hex(buf)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("multipart body", () => {
  test("includes string fields and the file part", () => {
    const { body, contentType } = buildMultipartBody(
      { key: "uploads/abc" },
      "kit.agentkit.zip",
      new Uint8Array([1, 2, 3])
    );
    const text = Buffer.from(body).toString("latin1");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(text).toContain('name="key"');
    expect(text).toContain("uploads/abc");
    expect(text).toContain('name="file"; filename="kit.agentkit.zip"');
    expect(text).toContain("application/zip");
  });
});

describe("market base URL normalization", () => {
  test("defaults to canonical host", () => {
    expect(normalizeMarketBaseUrl(undefined)).toBe(
      "https://market.agentkitproject.com"
    );
  });
  test("honors a self-host base URL", () => {
    expect(normalizeMarketBaseUrl("https://market.example.com")).toBe(
      "https://market.example.com"
    );
    expect(normalizeMarketBaseUrl("https://market.tailf14b5e.ts.net")).toBe(
      "https://market.tailf14b5e.ts.net"
    );
  });
  test("strips trailing slashes", () => {
    expect(normalizeMarketBaseUrl("https://market.example.com/")).toBe(
      "https://market.example.com"
    );
    expect(normalizeMarketBaseUrl("http://localhost:3000///")).toBe(
      "http://localhost:3000"
    );
  });
  test("rejects non-http(s) and unparseable URLs", () => {
    expect(() => normalizeMarketBaseUrl("ftp://market.example.com")).toThrow();
    expect(() => normalizeMarketBaseUrl("not a url")).toThrow();
  });
});

describe("market identifier normalization", () => {
  test("passes through a plain slug", () => {
    expect(normalizeMarketIdentifier("my-kit")).toBe("my-kit");
  });
  test("extracts slug from a Market URL", () => {
    expect(
      normalizeMarketIdentifier("https://market.agentkitproject.com/kits/my-kit")
    ).toBe("my-kit");
  });
  test("rejects empty input", () => {
    expect(() => normalizeMarketIdentifier("  ")).toThrow();
  });
});

describe("download provenance assembly", () => {
  test("assembles provenance from download info", () => {
    const provenance = assembleProvenance(
      {
        downloadUrl: "https://x/y",
        fileName: "cool-kit.agentkit.zip",
        version: "1.2.3",
        sha256: "ABCDEF",
        packageSizeBytes: 100,
        marketKitId: "kit_123",
        publishedAt: "2026-01-01T00:00:00Z"
      },
      "https://market.agentkitproject.com",
      "cool-kit",
      undefined
    );
    expect(provenance).toMatchObject({
      source: "market",
      marketBaseUrl: "https://market.agentkitproject.com",
      marketSlug: "cool-kit",
      marketKitId: "kit_123",
      version: "1.2.3",
      sha256: "abcdef",
      publishedAt: "2026-01-01T00:00:00Z",
      fileName: "cool-kit.agentkit.zip",
      packageSizeBytes: 100
    });
    expect(provenance.sourceUrl).toBe(
      "https://market.agentkitproject.com/kits/cool-kit"
    );
  });

  test("falls back to a derived filename and kitId override", () => {
    const provenance = assembleProvenance(
      { downloadUrl: "https://x/y" },
      "https://market.agentkitproject.com",
      "Some Kit!",
      "kit_fallback"
    );
    expect(provenance.fileName).toBe("Some-Kit-.agentkit.zip");
    expect(provenance.marketKitId).toBe("kit_fallback");
  });

  test("rejects unsafe file names", () => {
    expect(() =>
      assembleProvenance(
        { downloadUrl: "https://x/y", fileName: "../evil.agentkit.zip" },
        "https://market.agentkitproject.com",
        "k",
        undefined
      )
    ).toThrow(/unsafe/);
  });
});

describe("submit upload request shape (contract)", () => {
  let root: string;
  test("builds an upload request from a real kit", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "akf-submit-"));
    try {
      const created = await createAgentKit(root, {
        template: "blank",
        id: "demo-kit",
        name: "Demo Kit",
        description: "A demo kit.",
        force: true
      });
      const req = await buildForgeUploadRequest(created.rootPath, "  Jane Doe  ");
      // Contract shape: forgeUploadBackendRequest fields.
      expect(req.fileName).toMatch(/\.agentkit\.zip$/);
      expect(typeof req.version).toBe("string");
      expect(req.version.length).toBeGreaterThan(0);
      expect(req.publisherId).toBe("Jane Doe"); // trimmed
      expect(req.listingDraft).toMatchObject({
        name: expect.any(String),
        summary: expect.any(String),
        description: expect.any(String),
        categories: [],
        tags: []
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("import zip extraction", () => {
  test("round-trips a packaged kit through extract + safety guards", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "akf-imp-src-"));
    const out = await mkdtemp(path.join(os.tmpdir(), "akf-imp-out-"));
    try {
      const created = await createAgentKit(src, {
        template: "blank",
        id: "imp-kit",
        name: "Imp Kit",
        description: "Imp kit.",
        force: true
      });
      const zipPath = path.join(out, "kit.agentkit.zip");
      await packageAgentKit(created.rootPath, zipPath);
      const bytes = await readFile(zipPath);

      const dest = path.join(out, "extracted");
      await extractAgentKitZip(bytes, dest);
      const summary = await readFile(path.join(dest, "agentkit.yaml"), "utf8");
      expect(summary).toContain("schemaVersion");
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test("extraction guard rejects traversal entry names", () => {
    // extractAgentKitZip calls assertSafeRelativePath on every entry name
    // before resolving inside the target dir; this is that guard.
    expect(() => assertSafeRelativePath("../escape.txt")).toThrow(/\.\./);
    expect(() => assertSafeRelativePath("a/../../escape.txt")).toThrow();
  });
});
