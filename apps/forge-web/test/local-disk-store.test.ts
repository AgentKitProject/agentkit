import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDiskKitStore } from "@/server/store/local-disk";

let dataDir: string;
const USER = "user_test_123";

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "akf-store-test-"));
  process.env.AGENTKITFORGE_WEB_DATA_DIR = dataDir;
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("LocalDiskKitStore", () => {
  it("creates, reads, mutates, lists and deletes a kit tree", async () => {
    const store = new LocalDiskKitStore();
    const meta = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content: "name: Demo\n", encoding: "utf8" }] }
    });
    expect(meta.kitId).toBeTruthy();
    expect(meta.ownerUserId).toBe(USER);

    const tree = await store.getKitTree(USER, meta.kitId);
    expect(tree.files.some((f) => f.path === "agentkit.yaml")).toBe(true);

    await store.writeKitFile(USER, meta.kitId, { path: "skills/x/SKILL.md", content: "# x", encoding: "utf8" });
    const tree2 = await store.getKitTree(USER, meta.kitId);
    expect(tree2.files.some((f) => f.path === "skills/x/SKILL.md")).toBe(true);

    await store.deleteKitFile(USER, meta.kitId, "skills/x/SKILL.md");
    const tree3 = await store.getKitTree(USER, meta.kitId);
    expect(tree3.files.some((f) => f.path === "skills/x/SKILL.md")).toBe(false);

    const kits = await store.listUserKits(USER);
    expect(kits.length).toBe(1);

    await store.deleteKit(USER, meta.kitId);
    expect(await store.listUserKits(USER)).toHaveLength(0);
  });

  it("rejects path traversal in file paths", async () => {
    const store = new LocalDiskKitStore();
    const meta = await store.createKit(USER, {
      kind: "tree",
      source: "upload-zip",
      tree: { files: [{ path: "agentkit.yaml", content: "name: T\n" }] }
    });
    await expect(store.writeKitFile(USER, meta.kitId, { path: "../escape.txt", content: "x" })).rejects.toThrow();
    await store.deleteKit(USER, meta.kitId);
  });

  it("stores favorites as references and dedupes by slug", async () => {
    const store = new LocalDiskKitStore();
    await store.addFavorite(USER, { marketSlug: "alpha", marketBaseUrl: "https://m", displayName: "Alpha", addedAt: "t1" });
    await store.addFavorite(USER, { marketSlug: "alpha", marketBaseUrl: "https://m", displayName: "Alpha v2", addedAt: "t2" });
    await store.addFavorite(USER, { marketSlug: "beta", marketBaseUrl: "https://m", addedAt: "t3" });
    const favorites = await store.listFavorites(USER);
    expect(favorites).toHaveLength(2);
    expect(favorites.find((f) => f.marketSlug === "alpha")?.displayName).toBe("Alpha v2");
    await store.removeFavorite(USER, "alpha");
    expect(await store.listFavorites(USER)).toHaveLength(1);
  });
});
