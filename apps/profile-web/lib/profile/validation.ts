import type { EditableProfileInput, ProfileError } from "@/lib/profile/types";

const HANDLE_PATTERN = /^[a-z0-9_-]{3,32}$/;
const EMAIL_LIKE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RESERVED_HANDLES = new Set([
  "account",
  "admin",
  "agentkit",
  "agentkitproject",
  "api",
  "auth",
  "billing",
  "docs",
  "help",
  "login",
  "logout",
  "market",
  "profile",
  "root",
  "security",
  "settings",
  "sign-in",
  "sign-out",
  "support",
  "u",
]);

export function normalizeEditableProfileInput(input: Partial<EditableProfileInput>): EditableProfileInput {
  return {
    displayName: normalizeText(input.displayName),
    handle: normalizeHandle(input.handle),
    avatarInitials: normalizeText(input.avatarInitials).slice(0, 4).toUpperCase(),
    bio: normalizeText(input.bio).slice(0, 500),
    websiteUrl: normalizeText(input.websiteUrl),
  };
}

export function validateEditableProfileInput(input: EditableProfileInput): ProfileError[] {
  const errors: ProfileError[] = [];

  if (!input.displayName) {
    errors.push({ field: "displayName", message: "Display name is required for a complete profile." });
  }

  if (input.handle) {
    if (!HANDLE_PATTERN.test(input.handle)) {
      errors.push({
        field: "handle",
        message: "Handle must be 3-32 lowercase letters, numbers, hyphens, or underscores.",
      });
    }

    if (EMAIL_LIKE_PATTERN.test(input.handle)) {
      errors.push({ field: "handle", message: "Handle cannot look like an email address." });
    }

    if (RESERVED_HANDLES.has(input.handle)) {
      errors.push({ field: "handle", message: "That handle is reserved." });
    }
  }

  if (input.websiteUrl && !isHttpsUrl(input.websiteUrl)) {
    errors.push({ field: "websiteUrl", message: "Website URL must start with https://." });
  }

  return errors;
}

export function isValidHandle(handle: string) {
  return validateEditableProfileInput({
    displayName: "placeholder",
    handle: normalizeHandle(handle),
    avatarInitials: "",
    bio: "",
    websiteUrl: "",
  }).length === 0;
}

export function getProfileCompleteness(profile: Pick<EditableProfileInput, "displayName" | "handle" | "avatarInitials" | "bio" | "websiteUrl">) {
  const checks = [
    Boolean(profile.displayName),
    Boolean(profile.handle),
    Boolean(profile.avatarInitials),
    Boolean(profile.bio),
    Boolean(profile.websiteUrl),
  ];
  const completeCount = checks.filter(Boolean).length;

  return {
    completeness: Math.round((completeCount / checks.length) * 100),
    isComplete: Boolean(profile.displayName && profile.handle),
  };
}

export function normalizeHandle(value?: string | null) {
  return normalizeText(value).toLowerCase();
}

function normalizeText(value?: string | null) {
  return String(value ?? "").trim();
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
