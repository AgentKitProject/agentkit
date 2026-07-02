// LocalDiskKitStore — the one concrete KitStore adapter shipped today.
//
// Layout under AGENTKITFORGE_WEB_DATA_DIR (default ./.agentkitforge-data):
//   <dataDir>/users/<userId>/kits/<kitId>/tree/...        kit file tree
//   <dataDir>/users/<userId>/kits/<kitId>/metadata.json   metadata record
//   <dataDir>/users/<userId>/favorites.json               favorite refs array
//
// This runs the app WITHOUT cloud provisioning and is fully testable.
//
// TODO(hosted):    add S3KitStore (tree blobs in S3, metadata + favorites in
//                  DynamoDB). Same interface; swap via getKitStore().
// TODO(self-host): add PostgresKitStore (metadata + favorites in Postgres,
//                  tree blobs in MinIO/S3) — shareable with the Market
//                  self-host backend. Same interface; swap via getKitStore().
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCore } from "@/server/core/load-core";
import {
  type CreateKitInput,
  type FavoriteRecord,
  type KitFile,
  type KitMetadataRecord,
  type KitStore,
  type KitTree
} from "@/server/store/types";
import { getQuotaLimits, kitFileBytes, QuotaExceededError } from "@/server/store/quota";

const TREE_DIR = "tree";
const METADATA_FILE = "metadata.json";
const FAVORITES_FILE = "favorites.json";
const USAGE_FILE = "usage.json";

type UsageRecord = { kitCount: number; bytes: number };

function dataDir(): string {
  return process.env.AGENTKITFORGE_WEB_DATA_DIR || path.resolve(process.cwd(), ".agentkitforge-data");
}

// Reject path traversal / absolute paths in user-supplied ids and file paths.
function assertSafeSegment(segment: string, label: string): void {
  if (!segment || segment.includes("\0") || segment.includes("/") || segment.includes("\\") || segment === "." || segment === "..") {
    throw new Error(`Invalid ${label}.`);
  }
}

function normalizeRelPath(rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (norm.startsWith("/") || norm.startsWith("..") || norm.includes("\0")) {
    throw new Error(`Invalid file path: ${rel}`);
  }
  return norm;
}

function userDir(userId: string): string {
  assertSafeSegment(userId, "userId");
  return path.join(dataDir(), "users", userId);
}

function kitDir(userId: string, kitId: string): string {
  assertSafeSegment(kitId, "kitId");
  return path.join(userDir(userId), "kits", kitId);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

// --- tree <-> disk -----------------------------------------------------------

async function readTreeFromDir(root: string): Promise<KitTree> {
  const files: KitFile[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const buf = await fs.readFile(abs);
        if (isProbablyText(buf)) {
          files.push({ path: rel, content: buf.toString("utf8"), encoding: "utf8" });
        } else {
          files.push({ path: rel, content: buf.toString("base64"), encoding: "base64" });
        }
      }
    }
  }
  try {
    await walk(root, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

async function writeTreeToDir(root: string, tree: KitTree): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  for (const file of tree.files) {
    const rel = normalizeRelPath(file.path);
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    await fs.writeFile(abs, buf);
  }
}

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function parseKitName(tree: KitTree): string | undefined {
  const manifest = tree.files.find((f) => f.path === "agentkit.yaml");
  if (!manifest) return undefined;
  const match = manifest.content.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

export class LocalDiskKitStore implements KitStore {
  // --- quota helpers -------------------------------------------------------

  private usageFile(userId: string): string {
    return path.join(userDir(userId), USAGE_FILE);
  }

  private async readUsage(userId: string): Promise<UsageRecord> {
    return readJson<UsageRecord>(this.usageFile(userId), { kitCount: 0, bytes: 0 });
  }

  private async adjustUsage(userId: string, deltaKits: number, deltaBytes: number): Promise<void> {
    const current = await this.readUsage(userId);
    const next: UsageRecord = {
      kitCount: Math.max(0, current.kitCount + deltaKits),
      bytes: Math.max(0, current.bytes + deltaBytes)
    };
    await writeJson(this.usageFile(userId), next);
  }

  private treeBytes(tree: KitTree): number {
    return tree.files.reduce((sum, f) => sum + kitFileBytes(f.content, f.encoding), 0);
  }

  async getUsage(userId: string): Promise<{ kitCount: number; bytes: number }> {
    return this.readUsage(userId);
  }

  // --- owned kits ----------------------------------------------------------

  async createKit(userId: string, input: CreateKitInput): Promise<KitMetadataRecord> {
    const kitId = randomUUID();
    const now = new Date().toISOString();
    let tree: KitTree;
    let source: KitMetadataRecord["source"];
    let name: string | undefined;

    if (input.kind === "template") {
      // Materialize a template into a temp dir using core, then capture the tree.
      const core = await loadCore();
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "akf-tpl-"));
      try {
        const dest = path.join(tmp, "kit");
        await core.createAgentKit(dest, {
          template: input.template as Parameters<typeof core.createAgentKit>[1]["template"],
          id: input.id,
          name: input.name,
          description: input.description,
          force: true
        });
        tree = await readTreeFromDir(dest);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
      source = "template";
      name = input.name;
    } else {
      tree = input.tree;
      source = input.source;
      name = input.name ?? parseKitName(tree);
    }

    // Quota check (skip for template — core guarantees validity + bounded size).
    if (input.kind !== "template") {
      const limits = getQuotaLimits();
      const usage = await this.readUsage(userId);
      if (usage.kitCount >= limits.maxKits) {
        throw new QuotaExceededError(
          "kit-count",
          `Kit quota exceeded: you already have ${usage.kitCount} of ${limits.maxKits} kits. Delete a kit to make room.`
        );
      }
      const addedBytes = this.treeBytes(tree);
      if (usage.bytes + addedBytes > limits.maxBytes) {
        throw new QuotaExceededError(
          "total-bytes",
          `Storage quota exceeded: adding this kit would use ${Math.round((usage.bytes + addedBytes) / 1024 / 1024)} MB of your ${Math.round(limits.maxBytes / 1024 / 1024)} MB limit.`
        );
      }
    }

    const addedBytes = this.treeBytes(tree);
    const dir = kitDir(userId, kitId);
    await writeTreeToDir(path.join(dir, TREE_DIR), tree);
    const metadata: KitMetadataRecord = { kitId, ownerUserId: userId, name, createdAt: now, updatedAt: now, source };
    await writeJson(path.join(dir, METADATA_FILE), metadata);
    await this.adjustUsage(userId, 1, addedBytes);
    return metadata;
  }

  async listUserKits(userId: string): Promise<KitMetadataRecord[]> {
    const kitsRoot = path.join(userDir(userId), "kits");
    let entries: string[];
    try {
      entries = await fs.readdir(kitsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: KitMetadataRecord[] = [];
    for (const kitId of entries) {
      const meta = await readJson<KitMetadataRecord | null>(path.join(kitsRoot, kitId, METADATA_FILE), null);
      if (meta) records.push(meta);
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records;
  }

  async getKitMetadata(userId: string, kitId: string): Promise<KitMetadataRecord | null> {
    return readJson<KitMetadataRecord | null>(path.join(kitDir(userId, kitId), METADATA_FILE), null);
  }

  async getKitTree(userId: string, kitId: string): Promise<KitTree> {
    await this.requireKit(userId, kitId);
    return readTreeFromDir(path.join(kitDir(userId, kitId), TREE_DIR));
  }

  async putKitTree(userId: string, kitId: string, tree: KitTree): Promise<void> {
    await this.requireKit(userId, kitId);
    const dir = kitDir(userId, kitId);
    await writeTreeToDir(path.join(dir, TREE_DIR), tree);
    await this.touch(userId, kitId);
  }

  async writeKitFile(userId: string, kitId: string, file: KitFile): Promise<void> {
    await this.requireKit(userId, kitId);
    const limits = getQuotaLimits();
    const newFileBytes = kitFileBytes(file.content, file.encoding);
    if (newFileBytes > limits.maxBytesPerFile) {
      throw new QuotaExceededError(
        "file-bytes",
        `File too large: ${Math.round(newFileBytes / 1024 / 1024)} MB exceeds the ${Math.round(limits.maxBytesPerFile / 1024 / 1024)} MB per-file limit.`
      );
    }

    // Compute old file size for delta (if file exists).
    const rel = normalizeRelPath(file.path);
    const abs = path.join(kitDir(userId, kitId), TREE_DIR, rel);
    let oldBytes = 0;
    try {
      const oldBuf = await fs.readFile(abs);
      oldBytes = oldBuf.length;
    } catch {
      // File didn't exist — delta is just the new size.
    }
    const deltaBytes = newFileBytes - oldBytes;

    // Check total bytes quota only when growing.
    if (deltaBytes > 0) {
      const usage = await this.readUsage(userId);
      if (usage.bytes + deltaBytes > limits.maxBytes) {
        throw new QuotaExceededError(
          "total-bytes",
          `Storage quota exceeded: saving this file would use ${Math.round((usage.bytes + deltaBytes) / 1024 / 1024)} MB of your ${Math.round(limits.maxBytes / 1024 / 1024)} MB limit.`
        );
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    await fs.writeFile(abs, buf);
    await this.touch(userId, kitId);
    if (deltaBytes !== 0) await this.adjustUsage(userId, 0, deltaBytes);
  }

  async deleteKitFile(userId: string, kitId: string, filePath: string): Promise<void> {
    await this.requireKit(userId, kitId);
    const rel = normalizeRelPath(filePath);
    const abs = path.join(kitDir(userId, kitId), TREE_DIR, rel);
    let removedBytes = 0;
    try {
      const buf = await fs.readFile(abs);
      removedBytes = buf.length;
    } catch {
      // File didn't exist — nothing to remove.
    }
    await fs.rm(abs, { force: true });
    await this.touch(userId, kitId);
    if (removedBytes > 0) await this.adjustUsage(userId, 0, -removedBytes);
  }

  async deleteKit(userId: string, kitId: string): Promise<void> {
    // Compute tree size before deleting so we can decrement usage.
    let removedBytes = 0;
    try {
      const tree = await readTreeFromDir(path.join(kitDir(userId, kitId), TREE_DIR));
      removedBytes = this.treeBytes(tree);
    } catch {
      // Kit may not exist — just delete.
    }
    await fs.rm(kitDir(userId, kitId), { recursive: true, force: true });
    await this.adjustUsage(userId, -1, -removedBytes);
  }

  async addFavorite(userId: string, favorite: FavoriteRecord): Promise<FavoriteRecord> {
    const file = path.join(userDir(userId), FAVORITES_FILE);
    const favorites = await readJson<FavoriteRecord[]>(file, []);
    const filtered = favorites.filter((f) => f.marketSlug !== favorite.marketSlug);
    filtered.push(favorite);
    await writeJson(file, filtered);
    return favorite;
  }

  async listFavorites(userId: string): Promise<FavoriteRecord[]> {
    return readJson<FavoriteRecord[]>(path.join(userDir(userId), FAVORITES_FILE), []);
  }

  async removeFavorite(userId: string, marketSlug: string): Promise<void> {
    const file = path.join(userDir(userId), FAVORITES_FILE);
    const favorites = await readJson<FavoriteRecord[]>(file, []);
    await writeJson(
      file,
      favorites.filter((f) => f.marketSlug !== marketSlug)
    );
  }

  private async requireKit(userId: string, kitId: string): Promise<void> {
    const meta = await this.getKitMetadata(userId, kitId);
    if (!meta) {
      throw new Error("Kit not found.");
    }
  }

  private async touch(userId: string, kitId: string): Promise<void> {
    const meta = await this.getKitMetadata(userId, kitId);
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      await writeJson(path.join(kitDir(userId, kitId), METADATA_FILE), meta);
    }
  }
}

// Adapter selection (local | aws | selfhost) lives in server/store/index.ts.
// Re-exported here so existing callers can keep importing getKitStore from this
// module; it is now ASYNC because cloud adapters build their clients lazily.
export { getKitStore } from "@/server/store/index";
