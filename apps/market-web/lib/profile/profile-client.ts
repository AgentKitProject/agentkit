import { profileRoutes } from "@agentkitforge/contracts";
import type { PublicPublisherProfile } from "@/lib/profile/types";

export const PROFILE_FALLBACK: PublicPublisherProfile = {
  displayName: null,
  handle: null,
  avatarInitials: "AK",
  verified: false
};

export async function getPublicProfileForUser(userId: string): Promise<PublicPublisherProfile> {
  const baseUrl = process.env.PROFILE_API_BASE_URL?.replace(/\/+$/, "");

  if (!baseUrl) {
    logProfileFallback("missing-profile-api-base-url", userId);
    return PROFILE_FALLBACK;
  }

  try {
    const response = await fetch(`${baseUrl}${profileRoutes.publicByUserId(userId)}`, {
      cache: "no-store",
      headers: profileHeaders()
    });

    if (!response.ok) {
      logProfileFallback("profile-api-error", userId, response.status);
      return PROFILE_FALLBACK;
    }

    return normalizePublicProfile((await response.json()) as unknown);
  } catch (error) {
    logProfileFallback("profile-api-unavailable", userId, undefined, error);
    return PROFILE_FALLBACK;
  }
}

export function normalizePublicProfile(value: unknown): PublicPublisherProfile {
  const source = unwrapProfile(value);

  return {
    displayName: nullableString(source.displayName),
    handle: nullableString(source.handle),
    avatarInitials: nullableString(source.avatarInitials),
    verified: source.verified === true
  };
}

function profileHeaders() {
  const serviceKey = process.env.PROFILE_SERVICE_KEY;
  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  if (serviceKey) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  return headers;
}

function unwrapProfile(value: unknown) {
  if (!isObject(value)) {
    return {};
  }

  if (isObject(value.item)) {
    return value.item;
  }

  if (isObject(value.profile)) {
    return value.profile;
  }

  return value;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logProfileFallback(reason: string, userId: string, status?: number, error?: unknown) {
  console.warn("[agentkitmarket-profile] using safe public profile fallback", {
    reason,
    userIdHash: hashForLog(userId),
    status: status ?? null,
    error: error instanceof Error ? error.name : null
  });
}

function hashForLog(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
}
