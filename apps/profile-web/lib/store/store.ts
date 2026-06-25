/**
 * Profile store port + domain types for the in-process Postgres-backed
 * profile-api. Ported from the agentkitprofile-infra profile-api Lambda
 * (DynamoDB) — Postgres is the only implemented backend.
 *
 * The pure serialization shapers (`toPublicProfile`, `toFullProfileResponse`)
 * live ABOVE the store: they shape a `Profile` domain row into the wire JSON
 * that market/forge depend on. Public responses must NEVER leak `email`,
 * `role`, or timestamps — preserve `toPublicProfile` exactly.
 */

export type Role = "user" | "admin" | "owner";

/** Domain profile, mirroring the Lambda's `Profile` type. */
export type Profile = {
  userId: string;
  email?: string | null;
  displayName?: string | null;
  handle?: string | null;
  avatarInitials?: string | null;
  bio?: string | null;
  websiteUrl?: string | null;
  verified: boolean;
  role: Role;
  createdAt: string;
  updatedAt: string;
};

/** Public-safe shape served by GET /profiles/{userId} and /profiles/handle/{handle}. */
export type PublicProfile = {
  userId: string;
  displayName: string | null;
  handle: string | null;
  avatarInitials: string | null;
  bio: string | null;
  websiteUrl: string | null;
  verified: boolean;
};

/** Full shape served by GET/PUT /me (adds email, role, timestamps). */
export type FullProfileResponse = PublicProfile & {
  email: string | null;
  role: Role;
  createdAt: string;
  updatedAt: string;
};

export function toPublicProfile(profile: Profile): PublicProfile {
  return {
    userId: profile.userId,
    displayName: profile.displayName ?? null,
    handle: profile.handle ?? null,
    avatarInitials: profile.avatarInitials ?? null,
    bio: profile.bio ?? null,
    websiteUrl: profile.websiteUrl ?? null,
    verified: Boolean(profile.verified),
  };
}

export function toFullProfileResponse(profile: Profile): FullProfileResponse {
  return {
    ...toPublicProfile(profile),
    email: profile.email ?? null,
    role: profile.role,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Thrown by `updateProfileAndHandle` when the requested handle is already
 * reserved by another user (Postgres unique-violation 23505). Maps to HTTP 409
 * with the exact message "Handle is already taken".
 */
export class HandleTakenError extends Error {
  constructor() {
    super("Handle is already taken");
    this.name = "HandleTakenError";
  }
}

export interface ProfileStore {
  getByUserId(userId: string): Promise<Profile | null>;
  /** Case-insensitive; `handle` is expected already-lowercased by the caller. */
  getByHandle(handle: string): Promise<Profile | null>;
  /**
   * Lazy-create: insert the profile if absent, otherwise return the existing
   * row unchanged (`INSERT ... ON CONFLICT (user_id) DO NOTHING`, then re-select).
   */
  createIfAbsent(profile: Profile): Promise<Profile>;
  /** Update all mutable fields; `handle` is left unchanged by this op. */
  updateProfile(profile: Profile): Promise<void>;
  /**
   * Update the profile and set its handle to `nextHandle` (or clear it when
   * null) in a single statement. A unique-violation (SQLSTATE 23505) throws
   * `HandleTakenError`.
   */
  updateProfileAndHandle(profile: Profile, nextHandle: string | null): Promise<void>;
}
