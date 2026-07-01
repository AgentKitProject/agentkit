/**
 * Org route handlers for the Profile org seam — ported from agentkitmarket-core's
 * `core/routes/index.ts` org handlers, swapping `OrgRepository` → `OrgStore` and
 * the `CoreRequest`/`json()` plumbing for plain inputs + `HandlerResult` /
 * `ApiError` (mirroring `lib/profile-api/handlers.ts`).
 *
 * Role gates and the single-matching-org resolve rule are preserved verbatim.
 * The provider-key encrypt/decrypt happens HERE (the store sees only ciphertext),
 * using `lib/profile-api/org-key-crypto.ts` (PROFILE_KEY_ENCRYPTION_SECRET).
 *
 * Route files supply the auth mode (per-user trusted-context vs service-context)
 * and the asserted actor/target ids; these handlers never read auth headers.
 */

import {
  addOrgMemberRequestSchema,
  claimInvitesRequestSchema,
  createEmailInviteRequestSchema,
  createOrgRequestSchema,
  ensurePersonalOrgRequestSchema,
  orgUsagePeriodSchema,
  recordOrgUsageRequestSchema,
  recordUserOrgUsageRequestSchema,
  removeOrgMemberRequestSchema,
  setOrgApiKeyRequestSchema,
  setOrgMonthlyLimitsRequestSchema,
  setOrgRunBudgetRequestSchema,
  type OrgKeyProviderType,
  type OrgRole,
} from "@agentkitforge/contracts";
import type { OrgProviderKeyRecord, OrgRunBudgetRecord, OrgStore } from "../store/org-store.ts";
import { decryptSecret, encryptSecret } from "./org-key-crypto.ts";
import { ApiError } from "./validation.ts";

export type HandlerResult = { status: number; body: unknown };

/** owner/admin may manage members, keys, budgets, visibility, transfers. */
const MANAGE_ROLES: ReadonlySet<OrgRole> = new Set<OrgRole>(["owner", "admin"]);

const ORG_KEY_PROVIDER_TYPES: readonly OrgKeyProviderType[] = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "openai-compatible",
];

/** Validates a provider-type value against the 5-value union. */
export function parseProviderType(value: unknown): OrgKeyProviderType | undefined {
  return typeof value === "string" && (ORG_KEY_PROVIDER_TYPES as readonly string[]).includes(value)
    ? (value as OrgKeyProviderType)
    : undefined;
}

/** Last-4 mask of a decrypted key — never returns the raw key. */
function maskApiKey(key: string): string {
  return `…${key.slice(-4)}`;
}

// === org CRUD ==================================================================

/**
 * POST /orgs — create a team org. `ownerUserId` is the asserted actor (from the
 * trusted/service context, NOT the body), the body carries the org fields.
 */
export async function createOrg(
  store: OrgStore,
  ownerUserId: string,
  body: unknown,
): Promise<HandlerResult> {
  if (!ownerUserId) {
    throw new ApiError(400, "ownerUserId is required");
  }
  const parsed = createOrgRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid org payload");
  }
  const org = await store.createOrg({
    displayName: parsed.data.displayName,
    ownerUserId,
    type: "team",
    slug: parsed.data.slug,
    handle: parsed.data.handle,
  });
  return { status: 201, body: { item: org } };
}

/** GET /orgs/{orgId}. */
export async function getOrg(store: OrgStore, orgId: string): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  return { status: 200, body: { item: org } };
}

/**
 * GET /orgs/by-slug/{slug} — public org shape only (unauth-safe). Returns the
 * public subset: orgId, slug, displayName, handle, avatarInitials, verified.
 */
export async function getOrgBySlugPublic(store: OrgStore, slug: string): Promise<HandlerResult> {
  if (!slug) {
    throw new ApiError(400, "Missing slug");
  }
  const org = await store.getOrgBySlug(slug);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  return {
    status: 200,
    body: {
      item: {
        orgId: org.orgId,
        slug: org.slug,
        displayName: org.displayName,
        handle: org.handle,
        avatarInitials: org.avatarInitials,
        verified: org.verified,
      },
    },
  };
}

/**
 * DELETE /orgs/{orgId} — delete a TEAM org the actor owns/admins. Personal orgs
 * cannot be deleted. (Kit-ownership guard from market-core is dropped: Profile
 * has no kits table — Market enforces "no kits owned" before calling this in P2.)
 */
export async function deleteOrg(store: OrgStore, orgId: string, actorUserId: string): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId is required");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const actorMembership = await store.getMembership(orgId, actorUserId);
  if (!actorMembership || actorMembership.status !== "active" || !MANAGE_ROLES.has(actorMembership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can delete an organization" } };
  }
  if (org.type === "personal") {
    return { status: 409, body: { message: "Your personal organization cannot be deleted" } };
  }
  await store.deleteOrg(orgId);
  return { status: 200, body: { ok: true, orgId } };
}

// === members ==================================================================

export async function listMembers(store: OrgStore, orgId: string): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const members = await store.listMembers(orgId);
  return { status: 200, body: { items: members } };
}

export async function addMember(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  body: unknown,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId is required");
  }
  const parsed = addOrgMemberRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid member payload");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const actorMembership = await store.getMembership(orgId, actorUserId);
  if (!actorMembership || actorMembership.status !== "active" || !MANAGE_ROLES.has(actorMembership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can manage members" } };
  }
  const membership = await store.addMember(orgId, parsed.data.userId, parsed.data.role, actorUserId);
  return { status: 201, body: { item: membership } };
}

export async function removeMember(
  store: OrgStore,
  orgId: string,
  userId: string,
  actorUserId: string,
): Promise<HandlerResult> {
  if (!orgId || !userId) {
    throw new ApiError(400, "Missing orgId or userId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId is required");
  }
  const parsed = removeOrgMemberRequestSchema.safeParse({ userId });
  if (!parsed.success) {
    throw new ApiError(400, "Invalid remove payload");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const actorMembership = await store.getMembership(orgId, actorUserId);
  if (!actorMembership || actorMembership.status !== "active" || !MANAGE_ROLES.has(actorMembership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can manage members" } };
  }
  if (userId === org.ownerUserId) {
    return { status: 409, body: { message: "The org owner cannot be removed" } };
  }
  await store.removeMember(orgId, userId);
  return { status: 200, body: { ok: true } };
}

/**
 * GET /orgs/{orgId}/members/{userId} — hot membership check (service-context).
 * Returns `{ role, status }` (200) or 404 if no membership row exists.
 */
export async function getMembership(store: OrgStore, orgId: string, userId: string): Promise<HandlerResult> {
  if (!orgId || !userId) {
    throw new ApiError(400, "Missing orgId or userId");
  }
  const membership = await store.getMembership(orgId, userId);
  if (!membership) {
    return { status: 404, body: { message: "No membership for this user" } };
  }
  return { status: 200, body: { role: membership.role, status: membership.status } };
}

// === invites ==================================================================

export async function listUserInvites(store: OrgStore, userId: string): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const invites = await store.listInvitesForUser(userId);
  return { status: 200, body: { items: invites } };
}

export async function acceptInvite(store: OrgStore, orgId: string, userId: string): Promise<HandlerResult> {
  if (!orgId || !userId) {
    throw new ApiError(400, "Missing orgId or userId");
  }
  const membership = await store.acceptInvite(orgId, userId);
  if (!membership) {
    return { status: 404, body: { message: "No pending invite for this user" } };
  }
  return { status: 200, body: { item: membership } };
}

export async function createEmailInvite(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  body: unknown,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId is required");
  }
  const parsed = createEmailInviteRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid invite payload");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const actorMembership = await store.getMembership(orgId, actorUserId);
  if (!actorMembership || actorMembership.status !== "active" || !MANAGE_ROLES.has(actorMembership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can manage members" } };
  }
  const invite = await store.createEmailInvite(orgId, parsed.data.email, parsed.data.role, actorUserId);
  return { status: 201, body: { item: invite } };
}

export async function claimInvites(store: OrgStore, userId: string, body: unknown): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const parsed = claimInvitesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid claim payload");
  }
  const memberships = await store.claimInvitesByEmail(parsed.data.email, userId);
  return { status: 200, body: { items: memberships } };
}

// === user → orgs + personal org ===============================================

export async function listUserOrgs(store: OrgStore, userId: string): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const orgs = await store.listOrgsForUser(userId);
  return { status: 200, body: { items: orgs } };
}

/** POST /users/{userId}/personal-org — idempotently ensure the user's personal org. */
export async function ensurePersonalOrg(store: OrgStore, userId: string, body: unknown): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const parsed = ensurePersonalOrgRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid personal-org payload");
  }
  const org = await store.ensurePersonalOrg(userId, parsed.data.displayName);
  return { status: 200, body: { item: org } };
}

// === org shared provider key (encrypted at rest) ==============================

/** owner/admin gate shared by the set/clear key + budget ops. */
async function requireOrgManager(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
): Promise<{ ok: true } | HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId is required");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const membership = await store.getMembership(orgId, actorUserId);
  if (!membership || membership.status !== "active" || !MANAGE_ROLES.has(membership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can manage this organization" } };
  }
  return { ok: true };
}

/** POST /orgs/{orgId}/api-key — set (encrypt at rest) one provider's key. */
export async function setOrgApiKey(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  body: unknown,
): Promise<HandlerResult> {
  const gate = await requireOrgManager(store, orgId, actorUserId);
  if ("status" in gate) {
    return gate;
  }
  const parsed = setOrgApiKeyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid API key payload");
  }
  await store.setOrgProviderKey(orgId, {
    providerType: parsed.data.providerType,
    apiKeyCiphertext: encryptSecret(parsed.data.apiKey),
    baseUrl: parsed.data.baseUrl,
    updatedByUserId: actorUserId,
  });
  return { status: 200, body: { ok: true } };
}

/** DELETE /orgs/{orgId}/api-key?providerType=... — clear one provider's key. */
export async function clearOrgApiKey(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  providerTypeRaw: unknown,
): Promise<HandlerResult> {
  const gate = await requireOrgManager(store, orgId, actorUserId);
  if ("status" in gate) {
    return gate;
  }
  const providerType = parseProviderType(providerTypeRaw);
  if (!providerType) {
    throw new ApiError(400, "providerType query parameter is required");
  }
  await store.clearOrgProviderKey(orgId, providerType);
  return { status: 200, body: { ok: true } };
}

/** GET /orgs/{orgId}/api-key/status — masked status of ALL providers (owner/admin). */
export async function orgApiKeyStatus(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId query parameter is required");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const membership = await store.getMembership(orgId, actorUserId);
  if (!membership || membership.status !== "active" || !MANAGE_ROLES.has(membership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can read the API key status" } };
  }
  const records = await store.listOrgProviderKeys(orgId);
  return {
    status: 200,
    body: {
      providers: records.map((record) => ({
        providerType: record.providerType,
        maskedKey: maskApiKey(decryptSecret(record.apiKeyCiphertext)),
        baseUrl: record.baseUrl,
        updatedAt: record.updatedAt,
        updatedByUserId: record.updatedByUserId,
      })),
    },
  };
}

/**
 * GET /users/{userId}/org-api-key/resolve?providerType=... — service-context
 * runtime resolve (decrypted). Single-matching-org rule preserved: among the
 * user's ACTIVE-member orgs that carry a key FOR THE REQUESTED PROVIDER, return
 * it only when EXACTLY ONE has one; zero/more than one → `{ found:false }`.
 */
export async function resolveUserOrgApiKey(
  store: OrgStore,
  userId: string,
  providerTypeRaw: unknown,
): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const providerType = parseProviderType(providerTypeRaw);
  if (!providerType) {
    throw new ApiError(400, "providerType query parameter is required");
  }
  const orgs = await store.listOrgsForUser(userId);
  const withKey: { orgId: string; record: OrgProviderKeyRecord }[] = [];
  for (const org of orgs) {
    const membership = await store.getMembership(org.orgId, userId);
    if (!membership || membership.status !== "active") {
      continue;
    }
    const record = await store.getOrgProviderKey(org.orgId, providerType);
    if (record) {
      withKey.push({ orgId: org.orgId, record });
    }
  }
  if (withKey.length !== 1) {
    return { status: 200, body: { found: false } };
  }
  const { orgId, record } = withKey[0]!;
  return {
    status: 200,
    body: {
      found: true,
      orgId,
      apiKey: decryptSecret(record.apiKeyCiphertext),
      providerType: record.providerType,
      baseUrl: record.baseUrl,
    },
  };
}

// === org default run budget ===================================================

/** GET /orgs/{orgId}/run-budget — the org's default run budget or null (owner/admin). */
export async function orgRunBudgetStatus(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId query parameter is required");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const membership = await store.getMembership(orgId, actorUserId);
  if (!membership || membership.status !== "active" || !MANAGE_ROLES.has(membership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can read the run budget" } };
  }
  const record = await store.getOrgRunBudget(orgId);
  return { status: 200, body: { budgetCents: record ? record.budgetCents : null } };
}

/** POST /orgs/{orgId}/run-budget — upsert the org's default run budget. */
export async function setOrgRunBudget(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  body: unknown,
): Promise<HandlerResult> {
  const gate = await requireOrgManager(store, orgId, actorUserId);
  if ("status" in gate) {
    return gate;
  }
  const parsed = setOrgRunBudgetRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid run budget payload");
  }
  await store.setOrgRunBudget(orgId, {
    budgetCents: parsed.data.budgetCents,
    updatedByUserId: actorUserId,
  });
  return { status: 200, body: { ok: true } };
}

/** DELETE /orgs/{orgId}/run-budget — clear the org's default run budget. */
export async function clearOrgRunBudget(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
): Promise<HandlerResult> {
  const gate = await requireOrgManager(store, orgId, actorUserId);
  if ("status" in gate) {
    return gate;
  }
  await store.clearOrgRunBudget(orgId);
  return { status: 200, body: { ok: true } };
}

/**
 * GET /users/{userId}/org-run-budget/resolve — service-context runtime resolve.
 * Single-matching-org rule preserved: among the user's ACTIVE-member orgs that
 * have a default run budget set, return it only when EXACTLY ONE has one;
 * zero/more than one → `{ found:false }`.
 */
export async function resolveUserOrgRunBudget(store: OrgStore, userId: string): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const orgs = await store.listOrgsForUser(userId);
  const withBudget: OrgRunBudgetRecord[] = [];
  for (const org of orgs) {
    const membership = await store.getMembership(org.orgId, userId);
    if (!membership || membership.status !== "active") {
      continue;
    }
    const record = await store.getOrgRunBudget(org.orgId);
    if (record) {
      withBudget.push(record);
    }
  }
  if (withBudget.length !== 1) {
    return { status: 200, body: { found: false } };
  }
  return { status: 200, body: { found: true, budgetCents: withBudget[0]!.budgetCents } };
}

// === org monthly limits + usage (org budgets v2) ==============================

/** Null-cap shape returned when an org has no monthly limits configured. */
const NULL_MONTHLY_LIMITS = {
  poolCents: null,
  poolMinutes: null,
  memberCapCents: null,
  memberCapMinutes: null,
  maxPrivateKits: null,
} as const;

/**
 * GET /orgs/{orgId}/monthly-limits — the org's four nullable monthly caps
 * (owner/admin). Returns all-null when none configured.
 */
export async function orgMonthlyLimitsStatus(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId query parameter is required");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const membership = await store.getMembership(orgId, actorUserId);
  if (!membership || membership.status !== "active" || !MANAGE_ROLES.has(membership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can read the monthly limits" } };
  }
  const record = await store.getOrgMonthlyLimits(orgId);
  return { status: 200, body: record ? record.limits : { ...NULL_MONTHLY_LIMITS } };
}

/** POST /orgs/{orgId}/monthly-limits — upsert the org's monthly caps (owner/admin). */
export async function setOrgMonthlyLimits(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  body: unknown,
): Promise<HandlerResult> {
  const gate = await requireOrgManager(store, orgId, actorUserId);
  if ("status" in gate) {
    return gate;
  }
  const parsed = setOrgMonthlyLimitsRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid monthly limits payload");
  }
  await store.setOrgMonthlyLimits(orgId, {
    limits: {
      poolCents: parsed.data.poolCents,
      poolMinutes: parsed.data.poolMinutes,
      memberCapCents: parsed.data.memberCapCents,
      memberCapMinutes: parsed.data.memberCapMinutes,
      maxPrivateKits: parsed.data.maxPrivateKits,
    },
    updatedByUserId: actorUserId,
  });
  return { status: 200, body: { ok: true } };
}

/**
 * GET /orgs/{orgId}/private-kit-cap — service-context read of the org's configured
 * max private-kit count (private-kits A2). NO role gate: the asserted service
 * caller (market-core) passes orgId directly. Returns
 * `{ maxPrivateKits: number | null }` (null = unlimited / no org-configured cap;
 * also null when the org has no monthly-limits row at all).
 */
export async function orgPrivateKitCap(store: OrgStore, orgId: string): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  const record = await store.getOrgMonthlyLimits(orgId);
  return { status: 200, body: { maxPrivateKits: record ? record.limits.maxPrivateKits : null } };
}

/** DELETE /orgs/{orgId}/monthly-limits — clear the org's monthly caps (owner/admin). */
export async function clearOrgMonthlyLimits(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
): Promise<HandlerResult> {
  const gate = await requireOrgManager(store, orgId, actorUserId);
  if ("status" in gate) {
    return gate;
  }
  await store.clearOrgMonthlyLimits(orgId);
  return { status: 200, body: { ok: true } };
}

/** GET /orgs/{orgId}/usage?period=YYYY-MM — usage summary for a period (owner/admin). */
export async function orgUsageSummary(
  store: OrgStore,
  orgId: string,
  actorUserId: string,
  periodRaw: unknown,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (!actorUserId) {
    throw new ApiError(400, "actorUserId query parameter is required");
  }
  const period = orgUsagePeriodSchema.safeParse(periodRaw);
  if (!period.success) {
    throw new ApiError(400, "period query parameter (YYYY-MM) is required");
  }
  const org = await store.getOrg(orgId);
  if (!org) {
    return { status: 404, body: { message: "Organization not found" } };
  }
  const membership = await store.getMembership(orgId, actorUserId);
  if (!membership || membership.status !== "active" || !MANAGE_ROLES.has(membership.role)) {
    return { status: 403, body: { message: "Only an owner or admin can read usage" } };
  }
  const summary = await store.getOrgUsageSummary(orgId, period.data);
  return { status: 200, body: summary };
}

/**
 * GET /orgs/{orgId}/usage/check?userId=...&period=YYYY-MM — service-context
 * remaining check. No role gate (the asserted service caller passes orgId, userId,
 * period directly). Returns orgUsageCheckSchema.
 */
export async function checkOrgUsage(
  store: OrgStore,
  orgId: string,
  userIdRaw: unknown,
  periodRaw: unknown,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  if (typeof userIdRaw !== "string" || !userIdRaw) {
    throw new ApiError(400, "userId query parameter is required");
  }
  const period = orgUsagePeriodSchema.safeParse(periodRaw);
  if (!period.success) {
    throw new ApiError(400, "period query parameter (YYYY-MM) is required");
  }
  const check = await store.checkOrgUsageRemaining(orgId, userIdRaw, period.data);
  return { status: 200, body: check };
}

/**
 * POST /orgs/{orgId}/usage/record — service-context usage accumulation (Auto).
 * No role gate (asserted service caller). Body: recordOrgUsageRequestSchema.
 */
export async function recordOrgUsage(
  store: OrgStore,
  orgId: string,
  body: unknown,
): Promise<HandlerResult> {
  if (!orgId) {
    throw new ApiError(400, "Missing orgId");
  }
  const parsed = recordOrgUsageRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid usage payload");
  }
  await store.recordOrgUsage(
    orgId,
    parsed.data.userId,
    parsed.data.period,
    parsed.data.addCents,
    parsed.data.addMinutes,
  );
  return { status: 200, body: { ok: true } };
}

/**
 * Resolve the user's SINGLE org that has monthly limits configured (org budgets
 * v2). MIRRORS `resolveUserOrgRunBudget`: among the user's ACTIVE-member orgs that
 * have monthly limits set, return the orgId only when EXACTLY ONE has them;
 * zero/more than one → undefined. Used by both the user-keyed check + record
 * service hot-paths so they agree on which org applies.
 */
async function resolveUserMonthlyLimitsOrgId(
  store: OrgStore,
  userId: string,
): Promise<string | undefined> {
  const orgs = await store.listOrgsForUser(userId);
  const withLimits: string[] = [];
  for (const org of orgs) {
    const membership = await store.getMembership(org.orgId, userId);
    if (!membership || membership.status !== "active") {
      continue;
    }
    const record = await store.getOrgMonthlyLimits(org.orgId);
    if (record) {
      withLimits.push(org.orgId);
    }
  }
  return withLimits.length === 1 ? withLimits[0] : undefined;
}

/**
 * GET /users/{userId}/org-usage/check?period=YYYY-MM — service-context runtime
 * usage check. Resolves the user's single org with monthly limits set (see
 * resolveUserMonthlyLimitsOrgId) and returns its OrgUsageCheck. Fail-open:
 * `{ found:false }` when zero/ambiguous match. Returns
 * resolvedUserOrgUsageCheckSchema.
 */
export async function resolveUserOrgMonthlyUsageCheck(
  store: OrgStore,
  userId: string,
  periodRaw: unknown,
): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const period = orgUsagePeriodSchema.safeParse(periodRaw);
  if (!period.success) {
    throw new ApiError(400, "period query parameter (YYYY-MM) is required");
  }
  const orgId = await resolveUserMonthlyLimitsOrgId(store, userId);
  if (!orgId) {
    return { status: 200, body: { found: false } };
  }
  const check = await store.checkOrgUsageRemaining(orgId, userId, period.data);
  return { status: 200, body: { found: true, orgId, check } };
}

/**
 * POST /users/{userId}/org-usage/record — service-context usage accumulation.
 * Resolves the user's single org with monthly limits set and accumulates the
 * usage into the (org, member, period) row. Fail-open: `{ recorded:false }` when
 * zero/ambiguous match. Body: recordUserOrgUsageRequestSchema. Returns
 * resolvedUserOrgUsageRecordSchema.
 */
export async function recordUserOrgMonthlyUsage(
  store: OrgStore,
  userId: string,
  body: unknown,
): Promise<HandlerResult> {
  if (!userId) {
    throw new ApiError(400, "Missing userId");
  }
  const parsed = recordUserOrgUsageRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid usage payload");
  }
  const orgId = await resolveUserMonthlyLimitsOrgId(store, userId);
  if (!orgId) {
    return { status: 200, body: { recorded: false } };
  }
  await store.recordOrgUsage(
    orgId,
    userId,
    parsed.data.period,
    parsed.data.addCents,
    parsed.data.addMinutes,
  );
  return { status: 200, body: { recorded: true, orgId } };
}
