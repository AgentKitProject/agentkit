/**
 * S3-backed OutputStore (persisted run outputs) — shared by BOTH backends:
 *
 *   - aws/      → the hosted S3 outputs bucket (AUTO_OUTPUTS_BUCKET).
 *   - selfhost/ → the SAME S3-compatible client pointed at the bundled MinIO
 *                 (endpoint + forcePathStyle), exactly like the kit-tree store.
 *
 * Objects live under `auto-outputs/{runId}/{path}`. Downloads are served as
 * 15-minute presigned GET URLs so neither the UI nor destinations proxy bytes.
 * Retention: rely on bucket lifecycle rules where available; the run manifest
 * additionally stamps `expiresAt` (see run-output-persist.ts) so consumers can
 * enforce the deadline regardless.
 *
 * The presigner is injectable (tests stay offline); production lazy-imports
 * @aws-sdk/s3-request-presigner.
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { OutputStore } from "../../core/ports.js";

/** Key prefix for persisted run outputs. */
export const OUTPUTS_KEY_PREFIX = "auto-outputs";

/** Presigned-GET URL lifetime (seconds): 15 minutes. */
export const OUTPUT_PRESIGN_TTL_SECONDS = 15 * 60;

/** Thrown when an output path would escape the run's output prefix. */
export class OutputPathError extends Error {
  readonly name = "OutputPathError";
}

/** Normalizes a workspace-relative output path (rejects absolute/traversal). */
export function confineOutputPath(rawPath: string): string {
  const p = rawPath.replace(/\\/g, "/");
  if (p.length === 0 || p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) {
    throw new OutputPathError(`Output file path must be relative: ${rawPath}`);
  }
  const segments = p.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) {
    throw new OutputPathError(`Invalid output file path: ${rawPath}`);
  }
  return segments.join("/");
}

/** Builds the canonical S3 object key for a run's persisted output file. */
export function outputObjectKey(runId: string, path: string): string {
  return `${OUTPUTS_KEY_PREFIX}/${runId}/${confineOutputPath(path)}`;
}

/** Injectable presigner (tests). Defaults to @aws-sdk/s3-request-presigner. */
export type PresignGetFn = (
  client: S3Client,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface S3OutputStoreOptions {
  client: S3Client;
  /** The outputs bucket (hosted S3 or self-host MinIO). */
  bucket: string;
  /** Presigned-GET lifetime in seconds. Default OUTPUT_PRESIGN_TTL_SECONDS. */
  presignTtlSeconds?: number;
  /** Injectable presigner (tests). */
  presign?: PresignGetFn;
  /**
   * Ensure the bucket exists (Head → Create) LAZILY before the first put —
   * the self-host bundled-MinIO path, mirroring the kit-tree store. Default
   * false (hosted buckets are IaC-provisioned).
   */
  ensureBucket?: boolean;
}

export class S3OutputStore implements OutputStore {
  private ensured: Promise<void> | null = null;

  constructor(private readonly opts: S3OutputStoreOptions) {}

  private async ensureBucketOnce(): Promise<void> {
    if (!this.opts.ensureBucket) return;
    if (!this.ensured) {
      this.ensured = (async () => {
        try {
          await this.opts.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
          return;
        } catch {
          /* fall through to create */
        }
        try {
          await this.opts.client.send(new CreateBucketCommand({ Bucket: this.opts.bucket }));
        } catch (error) {
          const name =
            (error as { name?: string })?.name ?? (error as { Code?: string })?.Code;
          if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return;
          throw error;
        }
      })();
    }
    return this.ensured;
  }

  async putRunOutput(runId: string, path: string, bytes: Uint8Array): Promise<string> {
    await this.ensureBucketOnce();
    const key = outputObjectKey(runId, path);
    await this.opts.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: bytes }),
    );
    return key;
  }

  async presignGet(storeKey: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.opts.bucket, Key: storeKey });
    const expiresIn = this.opts.presignTtlSeconds ?? OUTPUT_PRESIGN_TTL_SECONDS;
    if (this.opts.presign) {
      return this.opts.presign(this.opts.client, command, { expiresIn });
    }
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(this.opts.client, command, { expiresIn });
  }

  async getRunOutput(storeKey: string): Promise<Uint8Array> {
    const res = await this.opts.client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: storeKey }),
    );
    const body = res.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
    if (!body) return new Uint8Array(0);
    return body.transformToByteArray();
  }

  async delete(storeKey: string): Promise<void> {
    await this.opts.client.send(
      new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: storeKey }),
    );
  }
}
