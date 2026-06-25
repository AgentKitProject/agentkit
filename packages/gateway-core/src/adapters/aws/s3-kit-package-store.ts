/**
 * S3 (AWS / DO Spaces) adapter for the managed-gateway KitPackageStore.
 *
 * Reads a kit package tree (the JSON blob the apps' KitStore adapters persist:
 * `{ files: [{ path, content, encoding }] }`) from an object-storage bucket. The
 * session's `systemPromptRef` is the object key (optionally prefixed). The
 * managed gateway uses this server-side to assemble the secret system prompt +
 * the kit's tools; the bytes are never logged or returned to the client.
 *
 * `@aws-sdk/client-s3` is imported LAZILY (inside the factory) so importing this
 * module never pulls the S3 SDK into a build that injects its own store (tests /
 * non-hosted). The S3 client is constructed by the caller (so endpoint /
 * forcePathStyle for DO Spaces, region, and credentials are the caller's
 * concern), exactly like auto-core's S3InputStore.
 */

import type { GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import type {
  KitPackageStore,
  KitPackageTree,
} from "../../core/services/kit-context-resolver.js";

export interface S3KitPackageStoreOptions {
  client: S3Client;
  /** The bucket holding staged kit packages. */
  bucket: string;
  /** Optional key prefix prepended to the session's systemPromptRef. */
  prefix?: string;
}

/** Drains an S3 GetObject body to a UTF-8 string across runtimes. */
async function bodyToString(out: GetObjectCommandOutput): Promise<string> {
  const body = out.Body as unknown;
  if (body && typeof (body as { transformToString?: unknown }).transformToString === "function") {
    return (body as { transformToString: (enc?: string) => Promise<string> }).transformToString(
      "utf8",
    );
  }
  // Fallback: async-iterable stream of chunks.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class S3KitPackageStore implements KitPackageStore {
  constructor(private readonly opts: S3KitPackageStoreOptions) {}

  async getKitPackage(key: string): Promise<KitPackageTree | undefined> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const objectKey = this.opts.prefix ? `${this.opts.prefix.replace(/\/+$/, "")}/${key}` : key;
    let out: GetObjectCommandOutput;
    try {
      out = await this.opts.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }),
      );
    } catch (err) {
      // NoSuchKey → treat as absent; rethrow anything else (auth/network).
      const name = (err as { name?: string } | undefined)?.name ?? "";
      if (name === "NoSuchKey" || name === "NotFound") return undefined;
      throw err;
    }
    const text = await bodyToString(out);
    const parsed = JSON.parse(text) as Partial<KitPackageTree>;
    return { files: Array.isArray(parsed.files) ? parsed.files : [] };
  }
}
