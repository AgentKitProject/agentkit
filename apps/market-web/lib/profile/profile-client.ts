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

/** True when the optional Profile service is wired up (PROFILE_API_BASE_URL set). */
export function isProfileConfigured(): boolean {
  return Boolean(process.env.PROFILE_API_BASE_URL?.trim());
}

/**
 * Resolve the publisher snapshot for a submitter, with a self-host fallback.
 *
 * When the optional Profile service is NOT configured (a self-host that didn't
 * deploy AgentKitProfile), `getPublicProfileForUser` returns a null-displayName
 * fallback, which would otherwise fail the "display name is required" submission
 * check. In that case we derive the publisher display name from the user's OIDC
 * identity (first/last name, else the email local-part) so kit submission works
 * WITHOUT Profile. When Profile IS configured, behaviour is unchanged — a user
 * with no profile display name is still asked to set one.
 */
export async function getPublisherSnapshotForUser(identity: {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}): Promise<PublicPublisherProfile> {
  const snapshot = await getPublicProfileForUser(identity.id);
  if (snapshot.displayName && snapshot.displayName.trim().length > 0) {
    return snapshot;
  }
  if (isProfileConfigured()) {
    // Profile present but the user hasn't set a display name — keep the existing
    // behaviour (the caller surfaces "set your display name").
    return snapshot;
  }
  // No Profile service → synthesize the publisher identity from OIDC. The snapshot
  // here is PROFILE_FALLBACK (placeholder "AK" initials), so derive matching ones.
  const displayName = derivePublisherDisplayName(identity);
  return { ...snapshot, displayName, avatarInitials: deriveAvatarInitials(displayName) };
}

/** OIDC identity → a non-empty display name (≤ 80 chars, the profile limit). */
function derivePublisherDisplayName(identity: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const fullName = [identity.firstName, identity.lastName]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  const local = identity.email.includes("@") ? identity.email.split("@")[0] : identity.email;
  return (fullName || local || identity.email).slice(0, 80);
}

/** 1–2 uppercase initials from a display name (≤ 3 chars, the profile limit). */
function deriveAvatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0]).join("");
  return (initials || name.slice(0, 2)).toUpperCase().slice(0, 3);
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
