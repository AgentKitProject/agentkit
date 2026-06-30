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
   * POST (set) one of an org's per-provider shared LLM API keys / DELETE (clear) one.
   * An org stores ONE key per provider (composite key `(orgId, providerType)`).
   *  - POST: body (`setOrgApiKeyRequestSchema`) carries `providerType` (which
   *    provider's key to set) + `actorUserId`; upserts that provider's key.
   *  - DELETE: the provider to clear is given as a `providerType` query param,
   *    e.g. `/admin/orgs/{orgId}/api-key?providerType=openai`. `actorUserId` is
   *    carried in the body.
   * The backend gates both to the org's owner/admin. The key is encrypted at
   * rest; this route never returns the raw key.
   */
  adminOrgApiKey: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/api-key`,
  /** GET — masked status of ALL of an org's per-provider API keys
   *  (`orgApiKeyStatusSchema`: `{ providers: [...] }`; never the raw keys). */
  adminOrgApiKeyStatus: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/api-key/status`,
  /**
   * GET — resolve the effective org API key for a USER for a SPECIFIC provider
   * (decrypted; Seam B only). `providerType` is a required query param, e.g.
   * `/admin/users/{userId}/org-api-key/resolve?providerType=openai`.
   * Auto / Forge call this at inference time. The multi-org selection rule lives
   * server-side: pick the user's single active-membership team org that holds a
   * key FOR THAT provider, else not-found.
   * Returns the raw key over the admin-key-authenticated in-cluster channel only.
   */
  adminResolveUserOrgApiKey: (userId: string, providerType: string) =>
    `/admin/users/${encodeURIComponent(userId)}/org-api-key/resolve?providerType=${encodeURIComponent(providerType)}`,
  /**
   * GET (read the org's default run budget) / POST (set it) / DELETE (clear it)
   * for the org-level default per-run budget that OVERRIDES each member's own
   * default. An org stores at most ONE budget (a nullable integer, US cents).
   *  - GET: returns `orgRunBudgetStatusSchema` (`{ budgetCents: number | null }`);
   *    owner/admin gated (actorUserId query param).
   *  - POST: body (`setOrgRunBudgetRequestSchema`) carries `budgetCents` +
   *    `actorUserId`; upserts the org default. Owner/admin gated.
   *  - DELETE: clears the org default (`actorUserId` in body). Owner/admin gated.
   */
  adminOrgRunBudget: (orgId: string) =>
    `/admin/orgs/${encodeURIComponent(orgId)}/run-budget`,
  /**
   * GET — resolve the effective org default run budget for a USER (Seam B). Auto
   * calls this at run-create time, AFTER the user's own default and BEFORE the
   * system fallback. The multi-org selection rule lives server-side: pick the
   * user's single active-membership org that HAS a default run budget set, else
   * not-found. Returns `resolvedOrgRunBudgetSchema` (`{ found, budgetCents? }`).
   */
  adminResolveUserOrgRunBudget: (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}/org-run-budget/resolve`
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
 * Provider an org key applies to. An org stores ONE key PER provider; a run uses
 * the org key whose provider matches the run's provider.
 *
 * MIRROR: this is the exact 5-value `AiProviderType` union from
 * `@agentkitforge/core` (`packages/core/src/providers/types.ts` + catalog.ts).
 * It is mirrored here (not imported) because `@agentkitforge/contracts` has no
 * dependency on `@agentkitforge/core`. Keep the two in sync if either changes.
 */
export const orgKeyProviderTypeSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "openai-compatible"
]);
export type OrgKeyProviderType = z.infer<typeof orgKeyProviderTypeSchema>;

/**
 * Browser routes (market-app, AuthKit-cookie auth, gated to org owner/admin) for
 * managing an org's per-provider shared API keys. The web UI sets/clears a
 * provider's key; the raw key is never read back (GET returns masked status
 * only, one row per configured provider).
 */
export const orgApiKeyRoutes = {
  /**
   * GET (masked status of ALL providers) / PUT (set one provider's key — body
   * carries `providerType`) / DELETE (clear one provider — `providerType` query
   * param, e.g. `?providerType=openai`) for the org's shared API keys.
   */
  orgApiKey: (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/api-key`
} as const;

/**
 * Body of PUT /api/orgs/{orgId}/api-key (browser) and POST the Seam-B
 * adminOrgApiKey. `providerType` identifies WHICH provider's key is being set
 * (an org holds one key per provider) and is required. `actorUserId` is injected
 * server-side from the session on the Seam-B hop (the browser body carries only
 * the key fields). Owner/admin gated.
 */
export const setOrgApiKeyRequestSchema = z.object({
  apiKey: z.string().min(1),
  providerType: orgKeyProviderTypeSchema,
  baseUrl: z.string().url().optional(),
  /** Set on the Seam-B hop from the authenticated session; absent on the browser body. */
  actorUserId: z.string().min(1).optional()
});
export type SetOrgApiKeyRequest = z.infer<typeof setOrgApiKeyRequestSchema>;

/** One configured per-provider org key, masked — safe to return to the browser. */
export const orgApiKeyProviderStatusSchema = z.object({
  providerType: orgKeyProviderTypeSchema,
  /** e.g. "sk-ant-…Xy12" — last few chars only. */
  maskedKey: z.string(),
  baseUrl: z.string().optional(),
  updatedAt: z.string(),
  updatedByUserId: z.string()
});
export type OrgApiKeyProviderStatus = z.infer<typeof orgApiKeyProviderStatusSchema>;

/**
 * Masked status of ALL of an org's per-provider API keys — safe to return to the
 * browser. The UI shows one row per configured provider; an empty list means the
 * org has no keys configured. Never includes the raw key.
 */
export const orgApiKeyStatusSchema = z.object({
  providers: z.array(orgApiKeyProviderStatusSchema)
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

// ---------------------------------------------------------------------------
// Org default run budget (Auto — org override of each member's per-run cap)
// ---------------------------------------------------------------------------

/**
 * Browser routes (market-app, AuthKit-cookie auth, gated to org owner/admin) for
 * the org's default per-run budget. The web UI reads/sets/clears one nullable
 * integer (US cents); when set it OVERRIDES every member's own default budget.
 */
export const orgRunBudgetRoutes = {
  /**
   * GET (read `{ budgetCents: number | null }`) / PUT (set — body carries
   * `budgetCents`) / DELETE (clear) for the org's default per-run budget.
   */
  orgRunBudget: (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/run-budget`
} as const;

/**
 * Body of PUT /api/orgs/{orgId}/run-budget (browser) and POST the Seam-B
 * adminOrgRunBudget. `budgetCents` is the org-wide default per-run cap (a
 * positive integer, US cents). `actorUserId` is injected server-side from the
 * session on the Seam-B hop (the browser body carries only `budgetCents`).
 * Owner/admin gated.
 */
export const setOrgRunBudgetRequestSchema = z.object({
  budgetCents: z.number().int().positive(),
  /** Set on the Seam-B hop from the authenticated session; absent on the browser body. */
  actorUserId: z.string().min(1).optional()
});
export type SetOrgRunBudgetRequest = z.infer<typeof setOrgRunBudgetRequestSchema>;

/**
 * Status of an org's default run budget — safe to return to the browser. A null
 * `budgetCents` means the org has no default configured (members fall back to
 * their own default).
 */
export const orgRunBudgetStatusSchema = z.object({
  budgetCents: z.number().int().positive().nullable()
});
export type OrgRunBudgetStatus = z.infer<typeof orgRunBudgetStatusSchema>;

/**
 * Result of resolving a user's effective org default run budget (Seam B / Seam
 * S). Returned to Auto at run-create time. `found:false` ⇒ no org default
 * applies (the caller falls through to the user's own default, then the system
 * fallback).
 */
export const resolvedOrgRunBudgetSchema = z.object({
  found: z.boolean(),
  budgetCents: z.number().int().positive().optional()
});
export type ResolvedOrgRunBudget = z.infer<typeof resolvedOrgRunBudgetSchema>;
