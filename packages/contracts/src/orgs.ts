import { z } from "zod";

/**
 * AgentKitMarket Organizations contracts.
 *
 * Covers all three Market Phase 2 org slices:
 *   Slice 1 — Organizations (create, list, invite by userId, accept)
 *   Slice 2 — Team roles (owner / admin / member / viewer + role changes)
 *   Slice 3 — Private catalogs (kit visibility public / private)
 *
 * Route builders are exported as extensions of the existing forgeMarketRoutes
 * and marketBackendRoutes objects in market.ts — see that file for object
 * declarations; these symbols augment the canonical route table in routes.json.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const orgTypeSchema = z.enum(["personal", "team"]);
export type OrgType = z.infer<typeof orgTypeSchema>;

/**
 * Org-member roles.
 * Slice 1 uses: owner, member.
 * Slice 2 adds:  admin, viewer.
 */
export const orgRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const orgMembershipStatusSchema = z.enum(["active", "invited", "removed"]);
export type OrgMembershipStatus = z.infer<typeof orgMembershipStatusSchema>;

/** Kit visibility: "public" = listed in the public catalog; "private" = org-only. */
export const kitVisibilitySchema = z.enum(["public", "private"]);
export type KitVisibility = z.infer<typeof kitVisibilitySchema>;

// ---------------------------------------------------------------------------
// Object schemas
// ---------------------------------------------------------------------------

export const organizationSchema = z.object({
  orgId: z.string().min(1),
  slug: z.string().min(1),
  displayName: z.string().min(1).max(80),
  type: orgTypeSchema,
  ownerUserId: z.string().min(1),
  handle: z.string().min(3).max(32).optional(),
  avatarInitials: z.string().max(3).optional(),
  verified: z.boolean().optional(),
  /** WorkOS Organization ID — null until SSO is configured (future). */
  workosOrganizationId: z.string().nullable().optional(),
  /**
   * Stripe Connect seller-payout fields (Market paid-kit seller payouts).
   * `stripeAccountId` is the org's Express connected-account id. `chargesEnabled`
   * /`payoutsEnabled` mirror the connected account's capability state (synced from
   * Stripe `account.updated`). `payoutOnboardedAt` is stamped once payouts first
   * become enabled. All optional/absent until the org begins payout onboarding.
   */
  stripeAccountId: z.string().optional(),
  chargesEnabled: z.boolean().optional(),
  payoutsEnabled: z.boolean().optional(),
  payoutOnboardedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Organization = z.infer<typeof organizationSchema>;

/** Public-safe subset of an Organization (catalog / profile display). */
export const publicOrganizationSchema = z.object({
  orgId: z.string().min(1),
  slug: z.string().min(1),
  displayName: z.string().min(1).max(80),
  handle: z.string().min(3).max(32).optional(),
  avatarInitials: z.string().max(3).optional(),
  verified: z.boolean().optional()
});
export type PublicOrganization = z.infer<typeof publicOrganizationSchema>;

export const orgMembershipSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  role: orgRoleSchema,
  status: orgMembershipStatusSchema,
  invitedByUserId: z.string().min(1).optional(),
  createdAt: z.string()
});
export type OrgMembership = z.infer<typeof orgMembershipSchema>;

/**
 * Pending org invite.
 * Slice 1: invites are by userId.  email is reserved for later email-invite slice.
 */
export const orgInviteSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: orgRoleSchema,
  invitedByUserId: z.string().min(1),
  createdAt: z.string()
});
export type OrgInvite = z.infer<typeof orgInviteSchema>;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const createOrgRequestSchema = z.object({
  displayName: z.string().min(1).max(80),
  slug: z.string().min(1).optional(),
  handle: z.string().min(3).max(32).optional()
});
export type CreateOrgRequest = z.infer<typeof createOrgRequestSchema>;

export const addOrgMemberRequestSchema = z.object({
  userId: z.string().min(1),
  role: orgRoleSchema
});
export type AddOrgMemberRequest = z.infer<typeof addOrgMemberRequestSchema>;

export const removeOrgMemberRequestSchema = z.object({
  userId: z.string().min(1)
});
export type RemoveOrgMemberRequest = z.infer<typeof removeOrgMemberRequestSchema>;

/**
 * Invite an email that is not yet a registered AgentKitMarket user.
 * Stored as a pending invite keyed by email (no userId); claimed on first login.
 */
export const createEmailInviteRequestSchema = z.object({
  email: z.string().email(),
  role: orgRoleSchema
});
export type CreateEmailInviteRequest = z.infer<typeof createEmailInviteRequestSchema>;

/** Claim all pending email invites matching an email on first login. */
export const claimInvitesRequestSchema = z.object({
  email: z.string().email()
});
export type ClaimInvitesRequest = z.infer<typeof claimInvitesRequestSchema>;

export const acceptOrgInviteRequestSchema = z.object({
  orgId: z.string().min(1)
});
export type AcceptOrgInviteRequest = z.infer<typeof acceptOrgInviteRequestSchema>;

export const transferKitRequestSchema = z.object({
  kitId: z.string().min(1),
  targetOrgId: z.string().min(1)
});
export type TransferKitRequest = z.infer<typeof transferKitRequestSchema>;

export const setKitVisibilityRequestSchema = z.object({
  kitId: z.string().min(1),
  visibility: kitVisibilitySchema
});
export type SetKitVisibilityRequest = z.infer<typeof setKitVisibilityRequestSchema>;

/** Response from a successful org deletion. */
export const deleteOrgResponseSchema = z.object({
  ok: z.literal(true),
  orgId: z.string().min(1)
});
export type DeleteOrgResponse = z.infer<typeof deleteOrgResponseSchema>;

// ---------------------------------------------------------------------------
// Route builders (Seam A — Forge ↔ market-app, Bearer auth)
// ---------------------------------------------------------------------------

/**
 * Org-related routes Forge calls on the Market web app (Seam A).
 * Extend forgeMarketRoutes in market.ts with these entries.
 */
export const forgeOrgRoutes = {
  /** GET /api/forge/orgs — list orgs the authenticated user belongs to. */
  listMyOrgs: () => "/api/forge/orgs",
  /** POST /api/forge/orgs — create a new org. */
  createOrg: () => "/api/forge/orgs",
  /** GET /api/forge/orgs/{orgId}/kits — list all kits owned by an org (incl private; requires active membership). */
  listOrgKits: (orgId: string) => `/api/forge/orgs/${encodeURIComponent(orgId)}/kits`,
  /** GET/POST /api/forge/orgs/{orgId}/members */
  orgMembers: (orgId: string) => `/api/forge/orgs/${encodeURIComponent(orgId)}/members`,
  /** DELETE /api/forge/orgs/{orgId}/members/{userId} */
  orgMember: (orgId: string, userId: string) =>
    `/api/forge/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
  /** GET /api/forge/orgs/invites — list pending invites for the authenticated user. */
  myOrgInvites: () => "/api/forge/orgs/invites",
  /** POST /api/forge/orgs/{orgId}/invites/accept */
  acceptOrgInvite: (orgId: string) =>
    `/api/forge/orgs/${encodeURIComponent(orgId)}/invites/accept`,
  /** DELETE /api/forge/orgs/{orgId} — delete a team org the user owns/admins. */
  deleteOrg: (orgId: string) => `/api/forge/orgs/${encodeURIComponent(orgId)}`,
  /** POST /api/forge/kits/{kitId}/transfer */
  transferKit: (kitId: string) => `/api/forge/kits/${encodeURIComponent(kitId)}/transfer`,
  /** POST /api/forge/kits/{kitId}/visibility */
  setKitVisibility: (kitId: string) => `/api/forge/kits/${encodeURIComponent(kitId)}/visibility`
} as const;

// ---------------------------------------------------------------------------
// Browser org-payout routes (market-app, AuthKit-cookie auth, owner/admin only)
// ---------------------------------------------------------------------------

/**
 * Seller-payout routes the Market web UI calls for Stripe Connect onboarding.
 * Browser-facing (AuthKit cookie session via requireUserForApi), gated to the
 * org's owner/admin. Stripe API calls live only in market-app — never in core.
 */
export const orgPayoutRoutes = {
  /** POST /api/orgs/{orgId}/payouts/onboard — create/continue Express onboarding; returns { url }. */
  beginOnboarding: (orgId: string) =>
    `/api/orgs/${encodeURIComponent(orgId)}/payouts/onboard`,
  /** GET /api/orgs/{orgId}/payouts/status — { stripeAccountId?, chargesEnabled, payoutsEnabled, needsOnboarding }. */
  payoutStatus: (orgId: string) =>
    `/api/orgs/${encodeURIComponent(orgId)}/payouts/status`
} as const;

// ---------------------------------------------------------------------------
// Route builders (Seam B — market-app ↔ agentkitmarket-infra, admin-key auth)
// ---------------------------------------------------------------------------

/**
 * Org-related backend routes market-app calls on the Market API Gateway (Seam B).
 * Extend marketBackendRoutes in market.ts with these entries.
 */
export const marketBackendOrgRoutes = {
  /** GET /admin/users/{userId}/orgs */
  adminListUserOrgs: (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}/orgs`,
  /** POST /admin/orgs */
  adminCreateOrg: () => "/admin/orgs",
  /** DELETE /admin/orgs/{orgId} */
  adminDeleteOrg: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}`,
  /** GET /admin/orgs/{orgId}/kits — list all kits owned by an org (incl private); actorUserId must be an active member. */
  adminListOrgKits: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/kits`,
  /** GET/POST /admin/orgs/{orgId}/members */
  adminOrgMembers: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/members`,
  /** PATCH/DELETE /admin/orgs/{orgId}/members/{userId} */
  adminOrgMember: (orgId: string, userId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
  /** GET /admin/users/{userId}/invites */
  adminListUserInvites: (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}/invites`,
  /** POST /admin/orgs/{orgId}/invites/{userId}/accept */
  adminAcceptInvite: (orgId: string, userId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(userId)}/accept`,
  /** POST /admin/orgs/{orgId}/invites/email — invite an as-yet-unregistered email. */
  adminCreateEmailInvite: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/invites/email`,
  /** POST /admin/users/{userId}/invites/claim — claim pending email invites on first login. */
  adminClaimInvites: (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}/invites/claim`,
  /** POST /admin/kits/{kitId}/transfer */
  adminTransferKit: (kitId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/transfer`,
  /** POST /admin/kits/{kitId}/visibility */
  adminSetKitVisibility: (kitId: string) =>
    `/admin/kits/${encodeURIComponent(kitId)}/visibility`,
  /** POST /admin/orgs/{orgId}/stripe-account — persist Stripe payout fields on an org. */
  adminSetOrgStripeAccount: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/stripe-account`,
  /** GET /admin/orgs/{orgId}/payout-status — read an org's stored Stripe payout fields. */
  adminOrgPayoutStatus: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/payout-status`,
  /** GET /admin/orgs/by-stripe-account/{id} — reverse lookup for the account.updated webhook. */
  adminOrgByStripeAccount: (stripeAccountId: string) =>
    `/admin/orgs/by-stripe-account/${encodeURIComponent(stripeAccountId)}`,
  /**
   * POST (set) / DELETE (clear) an org's shared LLM API key.
   * Body carries `actorUserId`; the backend gates to the org's owner/admin.
   * The key is encrypted at rest; this route never returns the raw key.
   */
  adminOrgApiKey: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/api-key`,
  /** GET — masked status of an org's API key (hasKey + masked + meta; never the raw key). */
  adminOrgApiKeyStatus: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/api-key/status`,
  /**
   * GET — resolve the effective org API key for a USER (decrypted; Seam B only).
   * Auto / Forge call this at inference time. The multi-org selection rule lives
   * server-side: pick the user's single team org that has a key, else not-found.
   * Returns the raw key over the admin-key-authenticated in-cluster channel only.
   */
  adminResolveUserOrgApiKey: (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}/org-api-key/resolve`
} as const;

// ---------------------------------------------------------------------------
// Seller-payout request schema (Seam B — set Stripe account fields on an org)
// ---------------------------------------------------------------------------

/**
 * Body of POST /admin/orgs/{orgId}/stripe-account. market-app resolves these
 * fields from Stripe (account create / account.updated) and the backend just
 * persists them. Core never calls Stripe.
 */
export const setOrgStripeAccountRequestSchema = z.object({
  stripeAccountId: z.string().min(1),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  payoutOnboardedAt: z.string().optional()
});
export type SetOrgStripeAccountRequest = z.infer<typeof setOrgStripeAccountRequestSchema>;

// ---------------------------------------------------------------------------
// Org shared LLM API key (Auto + Forge BYO-at-org-level)
// ---------------------------------------------------------------------------

/**
 * Provider an org key applies to. Anthropic only for now (Auto is Anthropic; the
 * Forge platform/managed path is Anthropic). Extensible if Forge BYO providers
 * diverge. A run only uses the org key when its provider matches.
 */
export const orgKeyProviderTypeSchema = z.enum(["anthropic"]);
export type OrgKeyProviderType = z.infer<typeof orgKeyProviderTypeSchema>;

/**
 * Browser routes (market-app, AuthKit-cookie auth, gated to org owner/admin) for
 * managing an org's shared API key. The web UI sets/clears it; the raw key is
 * never read back (GET returns masked status only).
 */
export const orgApiKeyRoutes = {
  /** GET (masked status) / PUT (set) / DELETE (clear) the org's shared API key. */
  orgApiKey: (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/api-key`
} as const;

/**
 * Body of PUT /api/orgs/{orgId}/api-key (browser) and POST the Seam-B
 * adminOrgApiKey. `actorUserId` is injected server-side from the session on the
 * Seam-B hop (the browser body carries only the key fields). Owner/admin gated.
 */
export const setOrgApiKeyRequestSchema = z.object({
  apiKey: z.string().min(1),
  providerType: orgKeyProviderTypeSchema.default("anthropic"),
  baseUrl: z.string().url().optional(),
  /** Set on the Seam-B hop from the authenticated session; absent on the browser body. */
  actorUserId: z.string().min(1).optional()
});
export type SetOrgApiKeyRequest = z.infer<typeof setOrgApiKeyRequestSchema>;

/** Masked status of an org's API key — safe to return to the browser. */
export const orgApiKeyStatusSchema = z.object({
  hasKey: z.boolean(),
  /** e.g. "sk-ant-…Xy12" — last few chars only; absent when hasKey is false. */
  maskedKey: z.string().optional(),
  providerType: orgKeyProviderTypeSchema.optional(),
  baseUrl: z.string().optional(),
  updatedAt: z.string().optional(),
  updatedByUserId: z.string().optional()
});
export type OrgApiKeyStatus = z.infer<typeof orgApiKeyStatusSchema>;

/**
 * Result of resolving a user's effective org key (Seam B, decrypted). Returned
 * only over the admin-key in-cluster channel to Auto / Forge at inference time.
 */
export const resolvedOrgApiKeySchema = z.object({
  found: z.boolean(),
  orgId: z.string().optional(),
  apiKey: z.string().optional(),
  providerType: orgKeyProviderTypeSchema.optional(),
  baseUrl: z.string().optional()
});
export type ResolvedOrgApiKey = z.infer<typeof resolvedOrgApiKeySchema>;
