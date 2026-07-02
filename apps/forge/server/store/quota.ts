// Quota constants for the hosted Web Forge KitStore.
//
// These are the FREE-TIER defaults. Paid tiers can override them by setting the
// matching env vars (useful in production without a code deploy):
//   FORGE_MAX_KITS_PER_ACCOUNT   — integer (default 25)
//   FORGE_MAX_BYTES_PER_ACCOUNT  — integer in bytes (default 250 MB)
//   FORGE_MAX_BYTES_PER_FILE     — integer in bytes (default 10 MB)
//
// Call getQuotaLimits() instead of reading these directly so callers are always
// consistent with the override mechanism.

export const DEFAULT_MAX_KITS_PER_ACCOUNT = 25;
export const DEFAULT_MAX_BYTES_PER_ACCOUNT = 250 * 1024 * 1024; // 250 MB
export const DEFAULT_MAX_BYTES_PER_FILE = 10 * 1024 * 1024; // 10 MB

export type QuotaLimits = {
  maxKits: number;
  maxBytes: number;
  maxBytesPerFile: number;
};

export function getQuotaLimits(): QuotaLimits {
  const maxKits = parseInt(process.env.FORGE_MAX_KITS_PER_ACCOUNT ?? "", 10);
  const maxBytes = parseInt(process.env.FORGE_MAX_BYTES_PER_ACCOUNT ?? "", 10);
  const maxBytesPerFile = parseInt(process.env.FORGE_MAX_BYTES_PER_FILE ?? "", 10);
  return {
    maxKits: Number.isFinite(maxKits) && maxKits > 0 ? maxKits : DEFAULT_MAX_KITS_PER_ACCOUNT,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES_PER_ACCOUNT,
    maxBytesPerFile:
      Number.isFinite(maxBytesPerFile) && maxBytesPerFile > 0 ? maxBytesPerFile : DEFAULT_MAX_BYTES_PER_FILE
  };
}

export type UsageSnapshot = {
  kitCount: number;
  bytes: number;
};

/** Thrown when a write would exceed a per-account or per-file quota. */
export class QuotaExceededError extends Error {
  readonly kind: "kit-count" | "total-bytes" | "file-bytes";
  constructor(kind: QuotaExceededError["kind"], message: string) {
    super(message);
    this.name = "QuotaExceededError";
    this.kind = kind;
  }
}

/** Byte size of a KitFile's content regardless of encoding. */
export function kitFileBytes(content: string, encoding?: "utf8" | "base64"): number {
  if (encoding === "base64") {
    // base64 encodes 3 bytes → 4 chars; rough byte size of the decoded binary.
    return Math.ceil((content.replace(/=*$/, "").length * 3) / 4);
  }
  return Buffer.byteLength(content, "utf8");
}
