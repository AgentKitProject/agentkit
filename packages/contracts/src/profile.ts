import { z } from "zod";

/**
 * AgentKitProfile seam (provider: agentkitprofile-infra profile-api Lambda).
 *
 * Consumers: agentkitprofile-app (trusted /me routes), agentkitmarket-app
 * (public publisher snapshots), future AgentKitAuto.
 */

/** Public-safe profile served by GET /profiles/{userId} and /profiles/handle/{handle}. */
export const publicPublisherProfileSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1).max(80).nullable(),
  handle: z.string().min(3).max(32).nullable(),
  avatarInitials: z.string().max(3).nullable(),
  bio: z.string().max(280).nullable(),
  websiteUrl: z.string().url().nullable(),
  verified: z.boolean()
});

export type PublicPublisherProfile = z.infer<typeof publicPublisherProfileSchema>;

/** Snapshot frozen into Market submissions and published kits. */
export const publisherSnapshotSchema = z.object({
  displayName: z.string().nullable(),
  handle: z.string().nullable(),
  avatarInitials: z.string().nullable(),
  verified: z.boolean()
});

export type PublisherSnapshot = z.infer<typeof publisherSnapshotSchema>;

/**
 * Route builders for the Profile API Gateway.
 * The base URL must be the agentkitprofile-infra API Gateway stage
 * (see environments.json `profileApi`), NOT the profile web app — the web app
 * does not serve these routes.
 *
 * There is intentionally no `/public` suffix on these paths.
 */
export const profileRoutes = {
  publicByUserId: (userId: string) => `/profiles/${encodeURIComponent(userId)}`,
  publicByHandle: (handle: string) => `/profiles/handle/${encodeURIComponent(handle)}`,
  /** Trusted route — requires x-profile-service-key + x-agentkit-user-* headers. */
  me: () => "/me"
} as const;

/** Trusted-context headers for the Profile API /me routes. */
export const profileTrustedHeaders = {
  serviceKey: "x-profile-service-key",
  userId: "x-agentkit-user-id",
  userRole: "x-agentkit-user-role",
  userEmail: "x-agentkit-user-email"
} as const;
