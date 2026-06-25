/**
 * Pure request-building for the presigned package upload, factored out so the
 * PUT-vs-multipart decision is unit-testable without a network.
 *
 * CRITICAL regression guard (we hit this in the Rust client): when the server
 * returns an EMPTY `fields` object (`{}`), the upload is a plain PUT to the
 * presigned URL — NOT a multipart POST. Multipart is used ONLY when `fields` is
 * a NON-EMPTY object whose values are all strings. `all()` over an empty map is
 * vacuously true, which would otherwise route `{}` down the multipart path and
 * earn a 403 from the PUT-presigned URL.
 */

import { createHash } from "node:crypto";

/** The presigned-upload instructions returned in the upload-url response. */
export interface PresignedUpload {
  uploadUrl: string;
  method?: string;
  fields?: Record<string, unknown> | null;
  headers?: Record<string, unknown> | null;
}

export type UploadPlan =
  | {
      kind: "multipart";
      url: string;
      /** String form fields to send alongside the file part. */
      fields: Record<string, string>;
    }
  | {
      kind: "binary";
      url: string;
      method: "PUT" | "POST";
      headers: Record<string, string>;
    };

/** True only for a NON-EMPTY object whose every value is a string. */
export function fieldsRequireMultipart(
  fields: Record<string, unknown> | null | undefined
): boolean {
  if (fields === null || fields === undefined || typeof fields !== "object") {
    return false;
  }
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([, value]) => typeof value === "string");
}

function stringRecord(
  source: Record<string, unknown> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (source && typeof source === "object") {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

/**
 * Decide how to upload the package bytes given the presigned response. Validates
 * the URL is HTTPS, mirroring the Rust `upload_hosted_market_submission_package`.
 */
export function planPackageUpload(upload: PresignedUpload): UploadPlan {
  let parsed: URL;
  try {
    parsed = new URL(upload.uploadUrl);
  } catch {
    throw new Error("Hosted Market returned an invalid package upload URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Hosted Market package upload URL must use HTTPS.");
  }

  if (fieldsRequireMultipart(upload.fields)) {
    return {
      kind: "multipart",
      url: upload.uploadUrl,
      fields: stringRecord(upload.fields)
    };
  }

  const method = (upload.method ?? "PUT").trim().toUpperCase();
  if (method !== "PUT" && method !== "POST") {
    throw new Error(
      "Hosted Market returned an unsupported package upload method."
    );
  }
  const headers = stringRecord(upload.headers);
  const hasContentType = Object.keys(headers).some(
    (key) => key.toLowerCase() === "content-type"
  );
  if (!hasContentType) {
    headers["Content-Type"] = "application/zip";
  }
  return { kind: "binary", url: upload.uploadUrl, method, headers };
}

/** Compute the lowercase hex sha256 of a buffer. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a multipart/form-data body for the multipart upload path. Returns the
 * body bytes and the Content-Type header (with boundary). The file is sent as
 * the `file` part with `application/zip`, matching the Rust client.
 */
export function buildMultipartBody(
  fields: Record<string, string>,
  fileName: string,
  fileBytes: Uint8Array
): { body: Uint8Array; contentType: string } {
  const boundary = `----agentkitforge${createHash("sha1")
    .update(`${fileName}:${fileBytes.length}:${Date.now()}`)
    .digest("hex")}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
    );
  }
  parts.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: application/zip\r\n\r\n`
    )
  );
  parts.push(fileBytes);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
