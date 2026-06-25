// SelfHostKitStore — self-host KitStore adapter (Postgres + MinIO/S3).
//
// LAYOUT
//   Kit file trees → MinIO (S3-compatible), one object per kit via S3TreeStore:
//       <bucket>/<prefix>kits/<userId>/<kitId>/tree.json
//   Kit metadata   → Postgres table kit_metadata (PK user_id, kit_id).
//
// Reuses @aws-sdk/client-s3 against the MinIO endpoint (forcePathStyle) so tree
// storage is byte-for-byte identical to the AWS adapter. The schema is created
// idempotently on startup (ensureSchema) and the bucket is ensured on startup
// (ensureBucket), mirroring the Market self-host backend. Same path-traversal
// guards via shared.ts.
//
// FAVORITES are VESTIGIAL here too (moved to Market in Phase 3): the methods
// no-op and nothing is persisted.
import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { S3TreeStore } from "@/server/store/s3-tree";
import { materializeTemplateTree } from "@/server/store/template-tree";
import { assertSafeSegment, normalizeRelPath, parseKitName } from "@/server/store/shared";
import { ensureSchema, type PgPool } from "@/server/store/selfhost-pg";
import { getQuotaLimits, kitFileBytes, QuotaExceededError } from "@/server/store/quota";
import {
  type CreateKitInput,
  type FavoriteRecord,
  type KitFile,
  type KitMetadataRecord,
  type KitStore,
  type KitTree
} from "@/server/store/types";

export type SelfHostKitStoreConfig = {
  s3Endpoint: string;
  s3Bucket: string;
  s3Prefix?: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  region?: string;
  /**
   * Force path-style S3 URLs. Required for MinIO/self-host; set false for real
   * AWS S3 (e.g. hosted on DOKS). Default true.
   */
  s3ForcePathStyle?: boolean;
  /** Ensure the MinIO bucket exists on startup. Default true. */
  ensureBucket?: boolean;
};

export class SelfHostKitStore implements KitStore {
  private readonly pool: PgPool;
  private readonly s3: S3Client;
  private readonly trees: S3TreeStore;
  private readonly bucket: string;
  private readonly ensureBucketOnStart: boolean;
  private ready: Promise<void> | null = null;

  constructor(pool: PgPool, config: SelfHostKitStoreConfig, deps?: { s3?: S3Client }) {
    this.pool = pool;
    this.bucket = config.s3Bucket;
    this.ensureBucketOnStart = config.ensureBucket ?? true;
    this.s3 =
      deps?.s3 ??
      new S3Client({
        endpoint: config.s3Endpoint,
        region: config.region ?? "us-east-1",
        forcePathStyle: config.s3ForcePathStyle ?? true,
        credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }
      });
    this.trees = new S3TreeStore(this.s3, { bucket: config.s3Bucket, prefix: config.s3Prefix });
  }

  private async init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureSchema(this.pool);
        if (this.ensureBucketOnStart) await this.ensureBucket();
      })();
    }
    return this.ready;
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // fall through to create
    }
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const name = (error as { name?: string; Code?: string })?.name ?? (error as { Code?: string })?.Code;
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
      throw new Error(`Failed to ensure kit-tree bucket "${this.bucket}": ${String(error)}`);
    }
  }

  // --- quota ---------------------------------------------------------------

  async getUsage(userId: string): Promise<{ kitCount: number; bytes: number }> {
    await this.init();
    assertSafeSegment(userId, "userId");
    const res = await this.pool.query(
      `SELECT kit_count, bytes FROM kit_usage WHERE user_id = $1`,
      [userId]
    );
    if (!res.rows[0]) return { kitCount: 0, bytes: 0 };
    return {
      kitCount: Number(res.rows[0].kit_count),
      bytes: Number(res.rows[0].bytes)
    };
  }

  private async adjustUsage(userId: string, deltaKits: number, deltaBytes: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO kit_usage (user_id, kit_count, bytes)
         VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET kit_count = GREATEST(0, kit_usage.kit_count + $2),
             bytes     = GREATEST(0, kit_usage.bytes     + $3)`,
      [userId, deltaKits, deltaBytes]
    );
  }

  private treeBytes(tree: KitTree): number {
    return tree.files.reduce((sum, f) => sum + kitFileBytes(f.content, f.encoding), 0);
  }

  // -------------------------------------------------------------------------

  async createKit(userId: string, input: CreateKitInput): Promise<KitMetadataRecord> {
    await this.init();
    assertSafeSegment(userId, "userId");
    const kitId = randomUUID();
    const now = new Date().toISOString();
    let tree: KitTree;
    let source: KitMetadataRecord["source"];
    let name: string | undefined;

    if (input.kind === "template") {
      tree = await materializeTemplateTree(input);
      source = "template";
      name = input.name;
    } else {
      tree = input.tree;
      source = input.source;
      name = input.name ?? parseKitName(tree);
    }

    // Quota check (skip for template).
    if (input.kind !== "template") {
      const limits = getQuotaLimits();
      const usage = await this.getUsage(userId);
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
    await this.trees.putTree(userId, kitId, tree);
    await this.pool.query(
      `INSERT INTO kit_metadata (user_id, kit_id, name, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, kitId, name ?? null, source, now, now]
    );
    await this.adjustUsage(userId, 1, addedBytes);
    return { kitId, ownerUserId: userId, name, createdAt: now, updatedAt: now, source };
  }

  async listUserKits(userId: string): Promise<KitMetadataRecord[]> {
    await this.init();
    assertSafeSegment(userId, "userId");
    const res = await this.pool.query(
      `SELECT * FROM kit_metadata WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId]
    );
    return res.rows.map(toMetadata);
  }

  async getKitMetadata(userId: string, kitId: string): Promise<KitMetadataRecord | null> {
    await this.init();
    assertSafeSegment(userId, "userId");
    assertSafeSegment(kitId, "kitId");
    const res = await this.pool.query(
      `SELECT * FROM kit_metadata WHERE user_id = $1 AND kit_id = $2`,
      [userId, kitId]
    );
    return res.rows[0] ? toMetadata(res.rows[0]) : null;
  }

  async getKitTree(userId: string, kitId: string): Promise<KitTree> {
    await this.requireKit(userId, kitId);
    return this.trees.getTree(userId, kitId);
  }

  async putKitTree(userId: string, kitId: string, tree: KitTree): Promise<void> {
    await this.requireKit(userId, kitId);
    await this.trees.putTree(userId, kitId, tree);
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

    const rel = normalizeRelPath(file.path);
    const tree = await this.trees.getTree(userId, kitId);
    const existing = tree.files.find((f) => f.path === rel);
    const oldBytes = existing ? kitFileBytes(existing.content, existing.encoding) : 0;
    const deltaBytes = newFileBytes - oldBytes;

    if (deltaBytes > 0) {
      const usage = await this.getUsage(userId);
      if (usage.bytes + deltaBytes > limits.maxBytes) {
        throw new QuotaExceededError(
          "total-bytes",
          `Storage quota exceeded: saving this file would use ${Math.round((usage.bytes + deltaBytes) / 1024 / 1024)} MB of your ${Math.round(limits.maxBytes / 1024 / 1024)} MB limit.`
        );
      }
    }

    const files = tree.files.filter((f) => f.path !== rel);
    files.push({ path: rel, content: file.content, encoding: file.encoding ?? "utf8" });
    await this.trees.putTree(userId, kitId, { files });
    await this.touch(userId, kitId);
    if (deltaBytes !== 0) await this.adjustUsage(userId, 0, deltaBytes);
  }

  async deleteKitFile(userId: string, kitId: string, filePath: string): Promise<void> {
    await this.requireKit(userId, kitId);
    const rel = normalizeRelPath(filePath);
    const tree = await this.trees.getTree(userId, kitId);
    const existing = tree.files.find((f) => f.path === rel);
    const removedBytes = existing ? kitFileBytes(existing.content, existing.encoding) : 0;
    await this.trees.putTree(userId, kitId, { files: tree.files.filter((f) => f.path !== rel) });
    await this.touch(userId, kitId);
    if (removedBytes > 0) await this.adjustUsage(userId, 0, -removedBytes);
  }

  async deleteKit(userId: string, kitId: string): Promise<void> {
    await this.init();
    assertSafeSegment(userId, "userId");
    assertSafeSegment(kitId, "kitId");
    let removedBytes = 0;
    try {
      const tree = await this.trees.getTree(userId, kitId);
      removedBytes = this.treeBytes(tree);
    } catch {
      // Tree may not exist.
    }
    await this.trees.deleteTree(userId, kitId);
    await this.pool.query(`DELETE FROM kit_metadata WHERE user_id = $1 AND kit_id = $2`, [userId, kitId]);
    await this.adjustUsage(userId, -1, -removedBytes);
  }

  // --- favorites: vestigial (moved to Market in Phase 3) --------------------
  async addFavorite(_userId: string, favorite: FavoriteRecord): Promise<FavoriteRecord> {
    return favorite;
  }
  async listFavorites(_userId: string): Promise<FavoriteRecord[]> {
    return [];
  }
  async removeFavorite(_userId: string, _marketSlug: string): Promise<void> {
    // no-op
  }

  private async requireKit(userId: string, kitId: string): Promise<void> {
    const meta = await this.getKitMetadata(userId, kitId);
    if (!meta) throw new Error("Kit not found.");
  }

  private async touch(userId: string, kitId: string): Promise<void> {
    await this.pool.query(
      `UPDATE kit_metadata SET updated_at = $3 WHERE user_id = $1 AND kit_id = $2`,
      [userId, kitId, new Date().toISOString()]
    );
  }
}

function toMetadata(row: Record<string, unknown>): KitMetadataRecord {
  return {
    kitId: String(row.kit_id),
    ownerUserId: String(row.user_id),
    name: (row.name as string | null) ?? undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    source: row.source as KitMetadataRecord["source"]
  };
}
