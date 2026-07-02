// S3 (and MinIO, which is S3-compatible) kit-tree blob storage.
//
// Each kit's file tree is stored as ONE object:
//   s3://<bucket>/<prefix>kits/<userId>/<kitId>/tree.json
// The body is the serialized KitTree (see shared.ts). One object per kit keeps
// listing/cost trivial and round-trips utf8/base64 file content faithfully.
//
// The AWS adapter uses this against real S3; the self-host adapter uses the same
// code against a MinIO endpoint (endpoint + forcePathStyle). Behavior is
// identical — only the client config differs.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertSafeSegment, deserializeTree, serializeTree } from "@/server/store/shared";
import type { KitTree } from "@/server/store/types";

export type S3TreeConfig = {
  bucket: string;
  /** Optional key prefix, e.g. "agentkitforge/". Defaults to "". */
  prefix?: string;
};

function treeKey(prefix: string, userId: string, kitId: string): string {
  assertSafeSegment(userId, "userId");
  assertSafeSegment(kitId, "kitId");
  return `${prefix}kits/${userId}/${kitId}/tree.json`;
}

export class S3TreeStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(client: S3Client, config: S3TreeConfig) {
    this.client = client;
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "";
  }

  async putTree(userId: string, kitId: string, tree: KitTree): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: treeKey(this.prefix, userId, kitId),
        Body: serializeTree(tree),
        ContentType: "application/json"
      })
    );
  }

  async getTree(userId: string, kitId: string): Promise<KitTree> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: treeKey(this.prefix, userId, kitId) })
      );
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) return { files: [] };
      return deserializeTree(await body.transformToByteArray());
    } catch (error) {
      if (isNoSuchKey(error)) return { files: [] };
      throw error;
    }
  }

  async deleteTree(userId: string, kitId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: treeKey(this.prefix, userId, kitId) })
    );
  }
}

function isNoSuchKey(error: unknown): boolean {
  const name = (error as { name?: string; Code?: string })?.name ?? (error as { Code?: string })?.Code;
  return name === "NoSuchKey" || name === "NotFound" || name === "404";
}
