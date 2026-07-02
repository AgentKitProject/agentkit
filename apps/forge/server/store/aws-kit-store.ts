// AwsKitStore — hosted (AWS) KitStore adapter.
//
// LAYOUT
//   Kit file trees  → S3, one object per kit:
//       s3://<S3_BUCKET>/<prefix>kits/<userId>/<kitId>/tree.json
//   Kit metadata    → DynamoDB table <DYNAMODB_KITS_TABLE>:
//       PK userId (S), SK kitId (S), plus name/createdAt/updatedAt/source.
//
// Mutating a single file (writeKitFile/deleteKitFile) does read-modify-write on
// the whole tree object — S3 has no partial object edit, and kit trees are
// small. Same path-traversal guards as the local adapter (via shared.ts).
//
// FAVORITES are VESTIGIAL: favorites moved to the Market cloud API in Phase 3
// (commit 495b435). The interface methods remain for source compatibility but
// this adapter NO-OPS them (listFavorites → []); nothing here is the source of
// truth for favorites. Do not reintroduce favorite storage here.
import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { S3TreeStore } from "@/server/store/s3-tree";
import { materializeTemplateTree } from "@/server/store/template-tree";
import { assertSafeSegment, normalizeRelPath, parseKitName } from "@/server/store/shared";
import { getQuotaLimits, kitFileBytes, QuotaExceededError } from "@/server/store/quota";
import {
  type CreateKitInput,
  type FavoriteRecord,
  type KitFile,
  type KitMetadataRecord,
  type KitStore,
  type KitTree
} from "@/server/store/types";

export type AwsKitStoreConfig = {
  kitsTable: string;
  s3Bucket: string;
  s3Prefix?: string;
  region?: string;
  /**
   * Explicit AWS credentials. Needed on Amplify SSR, whose managed compute role
   * can't be granted DynamoDB/S3 access — a scoped IAM user's keys are injected
   * via FORGE_AWS_* env vars (AWS_* names are reserved by Amplify). When absent,
   * the default credential chain is used (local role / env / profile).
   */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Optional endpoint override (e.g. dynamodb-local / LocalStack for tests). */
  dynamoEndpoint?: string;
  s3Endpoint?: string;
  /** forcePathStyle for S3-compatible endpoints in tests. */
  s3ForcePathStyle?: boolean;
};

// Sentinel kitId stored in DynamoDB for usage accounting. Real kit IDs are
// UUIDs with hyphens; this value cannot collide with them.
const USAGE_ITEM_KIT_ID = "#USAGE";

export class AwsKitStore implements KitStore {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly trees: S3TreeStore;
  private readonly table: string;

  constructor(config: AwsKitStoreConfig, deps?: { ddb?: DynamoDBDocumentClient; s3?: S3Client }) {
    this.table = config.kitsTable;
    const region = config.region ?? "us-east-1";
    const creds = config.credentials ? { credentials: config.credentials } : {};
    this.ddb =
      deps?.ddb ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region,
          ...creds,
          ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {})
        }),
        { marshallOptions: { removeUndefinedValues: true } }
      );
    const s3 =
      deps?.s3 ??
      new S3Client({
        region,
        ...creds,
        ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
        ...(config.s3ForcePathStyle ? { forcePathStyle: true } : {})
      });
    this.trees = new S3TreeStore(s3, { bucket: config.s3Bucket, prefix: config.s3Prefix });
  }

  // --- quota ---------------------------------------------------------------

  async getUsage(userId: string): Promise<{ kitCount: number; bytes: number }> {
    assertSafeSegment(userId, "userId");
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { userId, kitId: USAGE_ITEM_KIT_ID } })
    );
    if (!res.Item) return { kitCount: 0, bytes: 0 };
    return {
      kitCount: (res.Item.kitCount as number | undefined) ?? 0,
      bytes: (res.Item.bytes as number | undefined) ?? 0
    };
  }

  private async adjustUsage(userId: string, deltaKits: number, deltaBytes: number): Promise<void> {
    // Atomic ADD: initialise counters to 0 if the item doesn't exist.
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId, kitId: USAGE_ITEM_KIT_ID },
        UpdateExpression: "ADD kitCount :dk, #bytes :db",
        ExpressionAttributeNames: { "#bytes": "bytes" },
        ExpressionAttributeValues: { ":dk": deltaKits, ":db": deltaBytes }
      })
    );
  }

  private treeBytes(tree: KitTree): number {
    return tree.files.reduce((sum, f) => sum + kitFileBytes(f.content, f.encoding), 0);
  }

  // -------------------------------------------------------------------------

  async createKit(userId: string, input: CreateKitInput): Promise<KitMetadataRecord> {
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

    // Quota check (skip for template — core guarantees validity + bounded size).
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
    const metadata: KitMetadataRecord = { kitId, ownerUserId: userId, name, createdAt: now, updatedAt: now, source };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { userId, ...metadata } }));
    await this.adjustUsage(userId, 1, addedBytes);
    return metadata;
  }

  async listUserKits(userId: string): Promise<KitMetadataRecord[]> {
    assertSafeSegment(userId, "userId");
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId }
      })
    );
    // Exclude the synthetic usage sentinel item from the kit listing.
    const records = (res.Items ?? [])
      .filter((item) => item.kitId !== USAGE_ITEM_KIT_ID)
      .map(toMetadata);
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return records;
  }

  async getKitMetadata(userId: string, kitId: string): Promise<KitMetadataRecord | null> {
    assertSafeSegment(userId, "userId");
    assertSafeSegment(kitId, "kitId");
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { userId, kitId } }));
    return res.Item ? toMetadata(res.Item) : null;
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
    await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { userId, kitId } }));
    await this.adjustUsage(userId, -1, -removedBytes);
  }

  // --- favorites: vestigial (moved to Market in Phase 3) --------------------
  async addFavorite(_userId: string, favorite: FavoriteRecord): Promise<FavoriteRecord> {
    return favorite; // no-op; Market owns favorites now.
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
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId, kitId },
        UpdateExpression: "SET updatedAt = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() }
      })
    );
  }
}

function toMetadata(item: Record<string, unknown>): KitMetadataRecord {
  return {
    kitId: String(item.kitId),
    ownerUserId: String(item.ownerUserId ?? item.userId),
    name: item.name as string | undefined,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
    source: item.source as KitMetadataRecord["source"]
  };
}
