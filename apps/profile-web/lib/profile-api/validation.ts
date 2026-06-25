/**
 * Profile validation + normalization, ported verbatim from the
 * agentkitprofile-infra profile-api Lambda. Error messages are part of the wire
 * contract — keep them byte-for-byte.
 */

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

const reservedHandles = new Set([
  "admin",
  "account",
  "profile",
  "market",
  "forge",
  "auto",
  "support",
  "security",
  "api",
  "root",
  "system",
]);

export function normalizeHandle(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function validateHandle(handle: string): void {
  if (handle.length < 3 || handle.length > 32) {
    throw new ApiError(400, "Handle must be 3-32 characters");
  }
  if (!/^[a-z0-9_-]+$/.test(handle)) {
    throw new ApiError(400, "Handle may contain lowercase letters, numbers, hyphen, and underscore");
  }
  if (handle.includes("@") || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(handle)) {
    throw new ApiError(400, "Handle cannot look like an email address");
  }
  if (reservedHandles.has(handle)) {
    throw new ApiError(400, "Handle is reserved");
  }
}

export function validateDisplayName(value: string | null): void {
  if (value === null) {
    return;
  }
  if (value.length < 1 || value.length > 80) {
    throw new ApiError(400, "displayName must be 1-80 characters");
  }
}

export function validateBio(value: string | null): void {
  if (value !== null && value.length > 280) {
    throw new ApiError(400, "bio must be at most 280 characters");
  }
}

export function validateWebsiteUrl(value: string | null): void {
  if (value === null) {
    return;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("not https");
    }
  } catch {
    throw new ApiError(400, "websiteUrl must be a valid https URL or empty");
  }
}

export function validateAvatarInitials(value: string | null): void {
  if (value !== null && value.length > 3) {
    throw new ApiError(400, "avatarInitials must be at most 3 characters");
  }
}

export function deriveInitials(displayName: string | null, email?: string | null): string | null {
  const source = displayName || email?.split("@")[0] || "";
  const initials = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || null;
}

export function nullableString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export type UpdateProfileInput = {
  displayName?: unknown;
  handle?: unknown;
  avatarInitials?: unknown;
  bio?: unknown;
  websiteUrl?: unknown;
  email?: unknown;
};

export function parseUpdateInput(value: unknown): UpdateProfileInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }

  return value as UpdateProfileInput;
}
