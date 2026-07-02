// Shared helpers for all KitStore / UserSettingsStore adapters.
//
// These are deliberately backend-agnostic so the local-disk, AWS (S3+DynamoDB),
// and self-host (Postgres+MinIO) adapters share IDENTICAL safety guards and
// tree (de)serialization semantics. Anything an adapter does to a user-supplied
// id or file path must go through the guards here.
import crypto from "node:crypto";
import type { KitTree } from "@/server/store/types";

// --- path-traversal / id guards (mirror local-disk.ts exactly) --------------

/** Reject path traversal / separators / nul in user-supplied ids. */
export function assertSafeSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment.includes("\0") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment === "." ||
    segment === ".."
  ) {
    throw new Error(`Invalid ${label}.`);
  }
}

/** Normalize a POSIX-relative path and reject absolute / traversal / nul. */
export function normalizeRelPath(rel: string): string {
  const slashed = rel.replace(/\\/g, "/");
  // posix.normalize without importing path: collapse `.`/`..`/`//` segments.
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new Error(`Invalid file path: ${rel}`);
    }
    parts.push(part);
  }
  const norm = parts.join("/");
  if (!norm || slashed.startsWith("/") || rel.includes("\0")) {
    throw new Error(`Invalid file path: ${rel}`);
  }
  return norm;
}

// --- kit-name parsing (mirror local-disk.ts) --------------------------------

export function parseKitName(tree: KitTree): string | undefined {
  const manifest = tree.files.find((f) => f.path === "agentkit.yaml");
  if (!manifest) return undefined;
  const match = manifest.content.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

// --- tree <-> blob ----------------------------------------------------------
//
// Cloud adapters persist a kit's file tree as a single JSON blob (one S3 / MinIO
// object per kit). This keeps the per-kit object count at exactly 1, sidesteps
// per-file listing cost, and round-trips the KitTree faithfully (utf8/base64
// encoding preserved). Each file path is validated through normalizeRelPath on
// the way in so a malicious tree can never escape its prefix.

export function serializeTree(tree: KitTree): Buffer {
  const files = tree.files.map((f) => ({
    path: normalizeRelPath(f.path),
    content: f.content,
    encoding: f.encoding ?? "utf8"
  }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return Buffer.from(JSON.stringify({ files }), "utf8");
}

export function deserializeTree(buf: Buffer | Uint8Array | string): KitTree {
  const text = typeof buf === "string" ? buf : Buffer.from(buf).toString("utf8");
  const parsed = JSON.parse(text) as KitTree;
  return { files: parsed.files ?? [] };
}

// --- at-rest secret encryption (shared with user-settings adapters) ---------

let warnedNoSecret = false;

export function secretKey(): Buffer | null {
  const raw = process.env.AGENTKITFORGE_WEB_SECRET;
  if (!raw) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[store] AGENTKITFORGE_WEB_SECRET is not set — AI provider API keys are stored in PLAINTEXT. Set it to enable AES-256-GCM at-rest encryption."
      );
    }
    return null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return crypto.createHash("sha256").update(raw).digest();
}

const ENC_PREFIX = "enc:v1:";

export function encryptSecret(plain: string): string {
  const key = secretKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const key = secretKey();
  if (!key) throw new Error("Stored API key is encrypted but AGENTKITFORGE_WEB_SECRET is not set.");
  const [, , ivB64, tagB64, dataB64] = stored.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
