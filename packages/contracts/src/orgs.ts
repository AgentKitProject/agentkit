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

/**
 * Body of POST /users/{userId}/personal-org (Profile seam, service-key auth).
 * Idempotently ensures the user's personal org, using `displayName` for the org
 * name (and slug derivation) when the personal org is first created. The target
 * userId is the path parameter — never read from the body — so this is safe to
 * call with an asserted service-context userId.
 */
export const ensurePersonalOrgRequestSchema = z.object({
  displayName: z.string().min(1).max(80)
});
export type EnsurePersonalOrgRequest = z.infer<typeof ensurePersonalOrgRequestSchema>;

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
  /**
   * POST /admin/kits/by-slug/{slug}/transfer — slug variant for the browser UI,
   * which holds only the URL slug (a PRIVATE kit's kit_id can't be resolved via
   * the public catalog). The backend resolves slug→kit server-side.
   */
  adminTransferKitBySlug: (slug: string) =>
    `/admin/kits/by-slug/${encodeURIComponent(slug)}/transfer`,
  /** POST /admin/kits/by-slug/{slug}/visibility — slug variant (see adminTransferKitBySlug). */
  adminSetKitVisibilityBySlug: (slug: string) =>
    `/admin/kits/by-slug/${encodeURIComponent(slug)}/visibility`,
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
// Route builders (Profile seam — consumers ↔ AgentKitProfile, rooted at Profile)
//
// AgentKitProfile is becoming the system of record for org entities (orgs,
// memberships, invites, shared provider keys, run budgets). These are the routes
// AgentKitProfile SERVES. Two inbound auth modes back them (see the Profile-web
// trusted-context):
//   - per-user trusted-context (browser-originated CRUD): x-profile-service-key
//     + x-agentkit-user-id, where the header userId IS the actor;
//   - service-context (Auto/Market resolve hot-paths + membership lookups):
//     x-profile-service-key + an ASSERTED TARGET userId taken from the route/body
//     (the header userId is NOT forced to equal the subject).
// The resolve/status response shapes are the EXISTING ones (resolvedOrgApiKey*,
// resolvedOrgRunBudget*, orgApiKeyStatus*, orgRunBudgetStatus*) so P2 consumers
// parse unchanged.
// ---------------------------------------------------------------------------

export const profileOrgRoutes = {
  // --- org CRUD ---
  /** POST /orgs — create a team org (body: createOrgRequestSchema + ownerUserId). */
  createOrg: () => "/orgs",
  /** GET /orgs/{orgId} — fetch a single org. */
  getOrg: (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`,
  /** DELETE /orgs/{orgId} — delete a team org (owner/admin gated; body: actorUserId). */
  deleteOrg: (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`,
  /** GET /orgs/by-slug/{slug} — public org shape by slug (unauth-safe). */
  getOrgBySlug: (slug: string) => `/orgs/by-slug/${encodeURIComponent(slug)}`,

  // --- members ---
  /** GET (list) / POST (add) /orgs/{orgId}/members. */
  orgMembers: (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/members`,
  /** DELETE /orgs/{orgId}/members/{userId} — remove a member (owner/admin gated). */
  orgMember: (orgId: string, userId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
  /** GET /orgs/{orgId}/members/{userId} — hot membership check → {role,status}|404. */
  getMembership: (orgId: string, userId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,

  // --- invites ---
  /** POST /orgs/{orgId}/invites/email — invite an as-yet-unregistered email. */
  createEmailInvite: (orgId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/invites/email`,
  /** POST /orgs/{orgId}/invites/{userId}/accept — accept a pending invite. */
  acceptInvite: (orgId: string, userId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(userId)}/accept`,
  /** GET /users/{userId}/invites — pending invites for a user. */
  listUserInvites: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/invites`,
  /** POST /users/{userId}/invites/claim — claim pending email invites on first login. */
  claimInvites: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/invites/claim`,

  // --- user → orgs + personal org ---
  /** GET /users/{userId}/orgs — orgs the user belongs to. */
  listUserOrgs: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/orgs`,
  /** POST /users/{userId}/personal-org — idempotently ensure the user's personal org. */
  ensurePersonalOrg: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/personal-org`,

  // --- org shared provider key (encrypted at rest) ---
  /** POST (set) / DELETE (clear `?providerType=`) /orgs/{orgId}/api-key (owner/admin). */
  orgApiKey: (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/api-key`,
  /** GET /orgs/{orgId}/api-key/status — masked status of all providers (owner/admin). */
  orgApiKeyStatus: (orgId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/api-key/status`,
  /**
   * GET /users/{userId}/org-api-key/resolve?providerType=... — service-context
   * runtime resolve (decrypted). Returns resolvedOrgApiKeySchema. Fail-open
   * (`{ found:false }`) on no/ambiguous match.
   */
  resolveUserOrgApiKey: (userId: string, providerType: string) =>
    `/users/${encodeURIComponent(userId)}/org-api-key/resolve?providerType=${encodeURIComponent(providerType)}`,

  // --- org default run budget ---
  /** GET (read) / POST (set) / DELETE (clear) /orgs/{orgId}/run-budget (owner/admin). */
  orgRunBudget: (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/run-budget`,
  /**
   * GET /users/{userId}/org-run-budget/resolve — service-context runtime resolve.
   * Returns resolvedOrgRunBudgetSchema. Fail-open (`{ found:false }`).
   */
  resolveUserOrgRunBudget: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/org-run-budget/resolve`,

  // --- org monthly usage (org budgets v2) — user-keyed service hot-paths ---
  /**
   * GET /users/{userId}/org-usage/check?period=YYYY-MM — service-context runtime
   * usage check. Profile maps the user → their single org with monthly limits set
   * and returns its OrgUsageCheck. Returns resolvedUserOrgUsageCheckSchema.
   * Fail-open (`{ found:false }`).
   */
  resolveUserOrgUsageCheck: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/org-usage/check`,
  /**
   * POST /users/{userId}/org-usage/record — service-context usage accumulation.
   * Body: recordUserOrgUsageRequestSchema. Profile maps the user → their single
   * org with monthly limits and accumulates the usage. Returns
   * resolvedUserOrgUsageRecordSchema. Fail-open (`{ recorded:false }`).
   */
  recordUserOrgUsage: (userId: string) =>
    `/users/${encodeURIComponent(userId)}/org-usage/record`
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

// ---------------------------------------------------------------------------
// Org monthly limits + usage accumulation (Org budgets v2)
//
// ADDITIVE to the per-run budget above (org_run_budgets). This vertical adds two
// MONTHLY caps, each expressed in TWO units (US cents AND active-minutes):
//   - a PER-MEMBER monthly cap (each member's own monthly ceiling), and
//   - an ORG-WIDE monthly pool (a shared ceiling across all members).
// Every limit field is nullable: null = unlimited for that unit/scope. Usage is
// accumulated per (org, member, UTC month) and checked by Auto at run time.
// Applies on self-host AND hosted.
// ---------------------------------------------------------------------------

/** A non-negative integer limit, or null for "unlimited". */
const nullableNonNegInt = z.number().int().min(0).nullable();

/**
 * An org's monthly limits. Each of the four caps is independent and nullable
 * (null = unlimited):
 *   - `poolCents` / `poolMinutes`        — org-wide monthly pool (shared).
 *   - `memberCapCents` / `memberCapMinutes` — per-member monthly ceiling.
 */
export const orgMonthlyLimitsSchema = z.object({
  poolCents: nullableNonNegInt,
  poolMinutes: nullableNonNegInt,
  memberCapCents: nullableNonNegInt,
  memberCapMinutes: nullableNonNegInt,
  /**
   * Max number of PRIVATE kits the org may hold (private-kits A2). null =
   * unlimited (no org-configured cap). This is NOT a monthly/usage cap — it lives
   * on the same org-limits row for storage convenience, and is enforced by
   * market-core at set-private time (precedence: org cap → env default → unlimited).
   */
  maxPrivateKits: nullableNonNegInt
});
export type OrgMonthlyLimits = z.infer<typeof orgMonthlyLimitsSchema>;

/** A usage period: a UTC calendar month in `YYYY-MM` form. */
export const orgUsagePeriodSchema = z.string().regex(/^\d{4}-\d{2}$/);
export type OrgUsagePeriod = z.infer<typeof orgUsagePeriodSchema>;

/** One member's accumulated usage within a period. */
export const orgMemberUsageSchema = z.object({
  userId: z.string().min(1),
  spentCents: z.number().int().min(0),
  activeMinutes: z.number().min(0)
});
export type OrgMemberUsage = z.infer<typeof orgMemberUsageSchema>;

/**
 * An org's accumulated usage for a period: the org-wide totals plus the
 * per-member breakdown. `members` is empty when no usage was recorded.
 */
export const orgUsageSummarySchema = z.object({
  period: orgUsagePeriodSchema,
  orgTotalCents: z.number().int().min(0),
  orgTotalMinutes: z.number().min(0),
  members: z.array(orgMemberUsageSchema)
});
export type OrgUsageSummary = z.infer<typeof orgUsageSummarySchema>;

/**
 * Result of checking how much of a member's monthly caps + the org pool remain
 * for a period. Each `*Remaining*` field is null when that cap is unlimited;
 * otherwise it is `max(0, limit - used)`. `allowed` is true unless any CAPPED
 * unit/scope is exhausted (remaining 0). No limits set ⇒ `allowed:true`, all
 * remaining null. Auto consumes this at run time.
 */
export const orgUsageCheckSchema = z.object({
  allowed: z.boolean(),
  memberRemainingCents: z.number().int().min(0).nullable(),
  memberRemainingMinutes: z.number().min(0).nullable(),
  poolRemainingCents: z.number().int().min(0).nullable(),
  poolRemainingMinutes: z.number().min(0).nullable()
});
export type OrgUsageCheck = z.infer<typeof orgUsageCheckSchema>;

/**
 * Body of the service "record usage" call (Auto → Profile). Accumulates a
 * member's usage into the (org, member, period) row. `addCents` is an integer ≥
 * 0; `addMinutes` is a number ≥ 0 (active-minutes may be fractional).
 */
export const recordOrgUsageRequestSchema = z.object({
  userId: z.string().min(1),
  period: orgUsagePeriodSchema,
  addCents: z.number().int().min(0),
  addMinutes: z.number().min(0)
});
export type RecordOrgUsage = z.infer<typeof recordOrgUsageRequestSchema>;

/**
 * Result of the user-keyed service usage CHECK (Auto → Profile). Profile maps the
 * user → their single org that has monthly limits set and returns its
 * OrgUsageCheck. `found:false` ⇒ no org monthly limits apply (zero or ambiguous
 * match) and the caller proceeds (fail-open).
 */
export const resolvedUserOrgUsageCheckSchema = z.object({
  found: z.boolean(),
  orgId: z.string().min(1).optional(),
  check: orgUsageCheckSchema.optional()
});
export type ResolvedUserOrgUsageCheck = z.infer<typeof resolvedUserOrgUsageCheckSchema>;

/**
 * Body of the user-keyed service "record usage" call (Auto → Profile). Same
 * accumulation semantics as recordOrgUsageRequestSchema, but Profile resolves the
 * org from the user (so no orgId is supplied).
 */
export const recordUserOrgUsageRequestSchema = z.object({
  period: orgUsagePeriodSchema,
  addCents: z.number().int().min(0),
  addMinutes: z.number().min(0)
});
export type RecordUserOrgUsage = z.infer<typeof recordUserOrgUsageRequestSchema>;

/**
 * Result of the user-keyed service usage RECORD (Auto → Profile). `recorded:false`
 * ⇒ no org monthly limits applied (zero or ambiguous match); the call is a no-op.
 */
export const resolvedUserOrgUsageRecordSchema = z.object({
  recorded: z.boolean(),
  orgId: z.string().min(1).optional()
});
export type ResolvedUserOrgUsageRecord = z.infer<typeof resolvedUserOrgUsageRecordSchema>;

/**
 * Body of PUT /api/orgs/{orgId}/monthly-limits (browser) and POST the Profile-seam
 * monthly-limits route. Carries the four nullable caps; `actorUserId` is injected
 * server-side from the session on the seam hop (the browser body carries only the
 * limits). Owner/admin gated.
 */
export const setOrgMonthlyLimitsRequestSchema = orgMonthlyLimitsSchema.extend({
  /** Set on the seam hop from the authenticated session; absent on the browser body. */
  actorUserId: z.string().min(1).optional()
});
export type SetOrgMonthlyLimitsRequest = z.infer<typeof setOrgMonthlyLimitsRequestSchema>;

/**
 * Browser routes (market-app / profile-web web UI, session auth, gated to org
 * owner/admin) for the org's monthly limits + usage summary.
 */
export const orgMonthlyLimitsRoutes = {
  /**
   * GET (read the four nullable caps) / PUT (set them — body carries the caps) /
   * DELETE (clear all caps) for the org's monthly limits.
   */
  orgMonthlyLimits: (orgId: string) =>
    `/api/orgs/${encodeURIComponent(orgId)}/monthly-limits`,
  /** GET /api/orgs/{orgId}/usage?period=YYYY-MM — the org's usage summary for a period. */
  orgUsage: (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/usage`
} as const;

/**
 * Profile-seam routes AgentKitProfile SERVES for org monthly limits + usage. The
 * limits CRUD + usage summary are owner/admin gated (per-user trusted-context);
 * the usage-check + record-usage hot-paths are service-context (Auto asserts the
 * target userId).
 */
export const profileOrgUsageRoutes = {
  /** GET (read) / POST (set) / DELETE (clear) /orgs/{orgId}/monthly-limits (owner/admin). */
  orgMonthlyLimits: (orgId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/monthly-limits`,
  /** GET /orgs/{orgId}/usage?period=YYYY-MM — usage summary (owner/admin). */
  orgUsage: (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/usage`,
  /**
   * GET /orgs/{orgId}/usage/check?userId=...&period=YYYY-MM — service-context
   * remaining check (Auto). Returns orgUsageCheckSchema.
   */
  checkOrgUsage: (orgId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/usage/check`,
  /**
   * POST /orgs/{orgId}/usage/record — service-context usage accumulation (Auto).
   * Body: recordOrgUsageRequestSchema.
   */
  recordOrgUsage: (orgId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/usage/record`,
  /**
   * GET /orgs/{orgId}/private-kit-cap — service-context read of an org's
   * configured max private-kit count (private-kits A2). Returns
   * `orgPrivateKitCapSchema` (`{ maxPrivateKits: number | null }`; null =
   * unlimited / no org-configured cap). market-core calls this at set-private time
   * to override the env default.
   */
  orgPrivateKitCap: (orgId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/private-kit-cap`
} as const;

/**
 * Response of GET /orgs/{orgId}/private-kit-cap (private-kits A2). `maxPrivateKits`
 * is the org's configured private-kit cap, or null when the org has none set (=
 * unlimited / defer to the env default).
 */
export const orgPrivateKitCapSchema = z.object({
  maxPrivateKits: nullableNonNegInt
});
export type OrgPrivateKitCap = z.infer<typeof orgPrivateKitCapSchema>;
