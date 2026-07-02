// Tests for storage quotas and the kit validation gate.
//
// Covers:
//   - LocalDiskKitStore: kit-count quota, total-bytes quota, per-file quota,
//     deleteKit frees quota, deleteKitFile frees quota
//   - Validation gate: importPackageZip rejects non-kit zips (422 / KitValidationError)
//   - QuotaExceededError type and kind
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDiskKitStore } from "@/server/store/local-disk";
import { QuotaExceededError, DEFAULT_MAX_KITS_PER_ACCOUNT, DEFAULT_MAX_BYTES_PER_ACCOUNT, DEFAULT_MAX_BYTES_PER_FILE } from "@/server/store/quota";
import { KitValidationError } from "@/server/core/operations";

// ---------------------------------------------------------------------------
// Shared test setup
// ---------------------------------------------------------------------------

let dataDir: string;
const USER = "user_quota_test";

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "akf-quota-test-"));
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  delete process.env.FORGE_MAX_KITS_PER_ACCOUNT;
  delete process.env.FORGE_MAX_BYTES_PER_ACCOUNT;
  delete process.env.FORGE_MAX_BYTES_PER_FILE;
});

// Reset usage data between tests so tests are independent.
beforeEach(async () => {
  const userDataDir = path.join(dataDir, "users", USER);
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  // Reset env overrides.
  delete process.env.FORGE_MAX_KITS_PER_ACCOUNT;
  delete process.env.FORGE_MAX_BYTES_PER_ACCOUNT;
  delete process.env.FORGE_MAX_BYTES_PER_FILE;
});

// ---------------------------------------------------------------------------
// Helper: minimal valid tree (for plain createKit tests that don't need gating)
// ---------------------------------------------------------------------------
function minimalTree() {
  return {
    files: [{ path: "agentkit.yaml", content: "name: TestKit\n", encoding: "utf8" as const }]
  };
}

// ---------------------------------------------------------------------------
// 1. Kit-count quota
// ---------------------------------------------------------------------------

describe("LocalDiskKitStore — kit-count quota", () => {
  it("allows kits up to the limit", async () => {
    process.env.FORGE_MAX_KITS_PER_ACCOUNT = "2";
    const store = new LocalDiskKitStore();

    const k1 = await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });
    expect(k1.kitId).toBeTruthy();
    const k2 = await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });
    expect(k2.kitId).toBeTruthy();

    const usage = await store.getUsage(USER);
    expect(usage.kitCount).toBe(2);
  });

  it("throws QuotaExceededError(kit-count) when over limit", async () => {
    process.env.FORGE_MAX_KITS_PER_ACCOUNT = "2";
    const store = new LocalDiskKitStore();

    await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });
    await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });

    await expect(
      store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof QuotaExceededError && e.kind === "kit-count";
    });
  });

  it("allows creating again after deleteKit frees a slot", async () => {
    process.env.FORGE_MAX_KITS_PER_ACCOUNT = "1";
    const store = new LocalDiskKitStore();

    const k = await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });
    // Should be blocked:
    await expect(
      store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() })
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // Delete frees the slot:
    await store.deleteKit(USER, k.kitId);
    const usage = await store.getUsage(USER);
    expect(usage.kitCount).toBe(0);

    // Should succeed now:
    const k2 = await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });
    expect(k2.kitId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. Total-bytes quota
// ---------------------------------------------------------------------------

describe("LocalDiskKitStore — total-bytes quota", () => {
  it("throws QuotaExceededError(total-bytes) when tree would exceed byte limit", async () => {
    // Set a very tight byte limit (100 bytes).
    process.env.FORGE_MAX_BYTES_PER_ACCOUNT = "100";
    const store = new LocalDiskKitStore();

    const bigContent = "x".repeat(200); // 200 bytes > 100
    await expect(
      store.createKit(USER, {
        kind: "tree",
        source: "upload-zip",
        tree: { files: [{ path: "agentkit.yaml", content: bigContent, encoding: "utf8" }] }
      })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof QuotaExceededError && e.kind === "total-bytes";
    });
  });

  it("frees bytes when deleteKit is called", async () => {
    process.env.FORGE_MAX_BYTES_PER_ACCOUNT = String(DEFAULT_MAX_BYTES_PER_ACCOUNT);
    const store = new LocalDiskKitStore();
    const content = "a".repeat(500);

    const k = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content, encoding: "utf8" }] }
    });

    let usage = await store.getUsage(USER);
    expect(usage.bytes).toBeGreaterThan(0);

    await store.deleteKit(USER, k.kitId);
    usage = await store.getUsage(USER);
    expect(usage.bytes).toBe(0);
    expect(usage.kitCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-file quota
// ---------------------------------------------------------------------------

describe("LocalDiskKitStore — per-file quota", () => {
  it("throws QuotaExceededError(file-bytes) on writeKitFile over per-file limit", async () => {
    process.env.FORGE_MAX_BYTES_PER_FILE = "50";
    const store = new LocalDiskKitStore();

    const k = await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });
    const bigContent = "b".repeat(100); // 100 bytes > 50

    await expect(
      store.writeKitFile(USER, k.kitId, { path: "big.txt", content: bigContent, encoding: "utf8" })
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof QuotaExceededError && e.kind === "file-bytes";
    });
  });

  it("frees bytes when deleteKitFile is called", async () => {
    const store = new LocalDiskKitStore();
    const k = await store.createKit(USER, { kind: "tree", source: "upload-zip", tree: minimalTree() });

    await store.writeKitFile(USER, k.kitId, { path: "extra.txt", content: "hello world", encoding: "utf8" });
    const before = await store.getUsage(USER);
    expect(before.bytes).toBeGreaterThan(0);

    await store.deleteKitFile(USER, k.kitId, "extra.txt");
    const after = await store.getUsage(USER);
    expect(after.bytes).toBeLessThan(before.bytes);
  });
});

// ---------------------------------------------------------------------------
// 4. getUsage returns zeros for new user
// ---------------------------------------------------------------------------

describe("LocalDiskKitStore — getUsage", () => {
  it("returns zero usage for a fresh user", async () => {
    const store = new LocalDiskKitStore();
    const usage = await store.getUsage("never_created_user_xyz");
    expect(usage.kitCount).toBe(0);
    expect(usage.bytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Validation gate — import of a non-kit zip is rejected
// ---------------------------------------------------------------------------

describe("Validation gate — importPackageZip", () => {
  it("rejects a zip with no agentkit.yaml (not a kit)", async () => {
    // We need to mock validateAgentKit to fail for non-kit trees.
    // The real core isn't available in unit tests, so we mock the runner's
    // withEphemeralTree to simulate a validation failure by spying on loadCore.
    const loadCore = await import("@/server/core/load-core");
    const mockValidate = vi.fn().mockResolvedValue({ valid: false, errors: ["Missing agentkit.yaml"] });
    vi.spyOn(loadCore, "loadCore").mockResolvedValue({
      validateAgentKit: mockValidate
    } as any);

    const { importPackageZip } = await import("@/server/core/operations");

    // Build a minimal zip with no kit structure.
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("README.md", "# Not a kit");
    const zipBytes = await zip.generateAsync({ type: "nodebuffer" });

    await expect(importPackageZip(USER, zipBytes)).rejects.toBeInstanceOf(KitValidationError);

    vi.restoreAllMocks();
  });

  it("accepts a zip that passes local-valid validation", async () => {
    const loadCore = await import("@/server/core/load-core");
    vi.spyOn(loadCore, "loadCore").mockResolvedValue({
      validateAgentKit: vi.fn().mockResolvedValue({ valid: true, errors: [] })
    } as any);

    const { importPackageZip } = await import("@/server/core/operations");

    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("agentkit.yaml", "schemaVersion: '0.1'\nid: my-kit\nname: My Kit\n");
    zip.file("AGENTKIT.md", "# My Kit");
    zip.file("START_HERE.md", "Start here.");
    const zipBytes = await zip.generateAsync({ type: "nodebuffer" });

    const result = await importPackageZip(USER, zipBytes);
    expect(result.kitId).toBeTruthy();

    vi.restoreAllMocks();
  });
});
