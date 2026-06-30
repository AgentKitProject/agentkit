/**
 * Org store port + record types for the in-process Postgres-backed Profile org
 * API. Ported from agentkitmarket-core's `OrgRepository` (core/ports.ts) MINUS
 * the three kit-coupled methods (`setKitOwnerOrg`, `setKitVisibility`,
 * `listKitsForOrg`) — kit ownership/visibility stay in Market. Profile is
 * becoming the system of record for the org entity itself.
 *
 * Canonical org value types (Organization / OrgMembership / OrgInvite / OrgRole /
 * OrgKeyProviderType) come from `@agentkitforge/contracts` so both sides agree.
 * The two at-rest record types (provider key, run budget) are store-internal and
 * declared here, mirroring market-core's `OrgProviderKeyRecord` /
 * `OrgRunBudgetRecord`.
 */

import type {
  Organization,
  OrgInvite,
  OrgMembership,
  OrgRole,
  OrgKeyProviderType,
  OrgMonthlyLimits,
  OrgUsageSummary,
  OrgUsageCheck,
} from "@agentkitforge/contracts";

export type {
  Organization,
  OrgInvite,
  OrgMembership,
  OrgRole,
  OrgKeyProviderType,
  OrgMonthlyLimits,
  OrgUsageSummary,
  OrgUsageCheck,
} from "@agentkitforge/contracts";

/**
 * A stored org shared LLM API key (one per provider). `apiKeyCiphertext` is the
 * opaque at-rest value the store persists/returns verbatim; the handler layer
 * decrypts it. Mirrors market-core's `OrgProviderKeyRecord`.
 */
export interface OrgProviderKeyRecord {
  orgId: string;
  providerType: OrgKeyProviderType;
  apiKeyCiphertext: string;
  baseUrl?: string;
  updatedByUserId: string;
  updatedAt: string;
}

/** An org's default per-run budget (US cents). At most one per org. */
export interface OrgRunBudgetRecord {
  orgId: string;
  budgetCents: number;
  updatedByUserId: string;
  updatedAt: string;
}

/**
 * An org's monthly limits (org budgets v2). At most one per org. Each of the four
 * caps is nullable (null = unlimited): `limits` carries the cap values; the
 * record adds audit fields. Mirrors `OrgRunBudgetRecord`'s shape.
 */
export interface OrgMonthlyLimitsRecord {
  orgId: string;
  limits: OrgMonthlyLimits;
  updatedByUserId: string;
  updatedAt: string;
}

/**
 * Organizations, memberships, invites, shared provider keys + run budgets.
 * Mirrors `OrgRepository` from `@agentkit-commercial`/market-core EXCEPT the
 * kit-mutating methods, which remain in Market.
 */
export interface OrgStore {
  /** Creates an org with a unique slug (numeric-suffix dedupe) and an active owner membership. */
  createOrg(input: {
    displayName: string;
    ownerUserId: string;
    type?: "personal" | "team";
    slug?: string;
    handle?: string;
  }): Promise<Organization>;
  getOrg(orgId: string): Promise<Organization | undefined>;
  getOrgBySlug(slug: string): Promise<Organization | undefined>;
  /** Idempotently returns the user's personal org, creating it if absent. */
  ensurePersonalOrg(userId: string, displayName: string): Promise<Organization>;
  /** Orgs the user is an active or invited member of. */
  listOrgsForUser(userId: string): Promise<Organization[]>;
  getMembership(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  listMembers(orgId: string): Promise<OrgMembership[]>;
  /** Adds an `invited` membership + a pending invite for the user. */
  addMember(orgId: string, userId: string, role: OrgRole, invitedBy: string): Promise<OrgMembership>;
  /** Flips an `invited` membership to `active` and clears the invite. */
  acceptInvite(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  listInvitesForUser(userId: string): Promise<OrgInvite[]>;
  /**
   * Stores a pending invite keyed by email (no userId) — for inviting a person who is
   * not yet a registered user. Claimed on their first login via `claimInvitesByEmail`.
   */
  createEmailInvite(orgId: string, email: string, role: OrgRole, invitedBy: string): Promise<OrgInvite>;
  /** Pending email invites matching an email (normalized: trimmed + lowercased). */
  listInvitesByEmail(email: string): Promise<OrgInvite[]>;
  /**
   * Claims every pending email invite matching `email` for `userId`: creates an active
   * membership and deletes the email invite. Idempotent (skips orgs the user already
   * belongs to). Returns the memberships created.
   */
  claimInvitesByEmail(email: string, userId: string): Promise<OrgMembership[]>;
  removeMember(orgId: string, userId: string): Promise<void>;
  /** Hard-deletes an org and all its memberships + invites. Caller enforces guards. */
  deleteOrg(orgId: string): Promise<void>;
  /**
   * Org shared LLM API keys (encrypted at rest). An org holds ONE key PER
   * provider, keyed on the composite `(orgId, providerType)`. The store deals in
   * CIPHERTEXT only — encryption/decryption happens in the handler layer.
   */
  setOrgProviderKey(orgId: string, input: {
    providerType: OrgKeyProviderType;
    apiKeyCiphertext: string;
    baseUrl?: string;
    updatedByUserId: string;
  }): Promise<void>;
  getOrgProviderKey(orgId: string, providerType: OrgKeyProviderType): Promise<OrgProviderKeyRecord | undefined>;
  listOrgProviderKeys(orgId: string): Promise<OrgProviderKeyRecord[]>;
  clearOrgProviderKey(orgId: string, providerType: OrgKeyProviderType): Promise<void>;
  /**
   * Org default per-run budget (Auto). At most ONE per org: a positive integer in
   * US cents that OVERRIDES each member's own default budget.
   */
  setOrgRunBudget(orgId: string, input: { budgetCents: number; updatedByUserId: string }): Promise<void>;
  getOrgRunBudget(orgId: string): Promise<OrgRunBudgetRecord | undefined>;
  clearOrgRunBudget(orgId: string): Promise<void>;
  /**
   * Org monthly limits (org budgets v2) — ADDITIVE to the per-run budget above.
   * At most ONE row per org; each of the four caps is nullable (null = unlimited).
   */
  getOrgMonthlyLimits(orgId: string): Promise<OrgMonthlyLimitsRecord | undefined>;
  setOrgMonthlyLimits(orgId: string, input: { limits: OrgMonthlyLimits; updatedByUserId: string }): Promise<void>;
  clearOrgMonthlyLimits(orgId: string): Promise<void>;
  /** Sum + per-member usage rows for an org in a period (UTC month, YYYY-MM). */
  getOrgUsageSummary(orgId: string, period: string): Promise<OrgUsageSummary>;
  /** One member's accumulated usage for a period (zeros when no row exists). */
  getMemberUsage(orgId: string, userId: string, period: string): Promise<{ spentCents: number; activeMinutes: number }>;
  /** Accumulate a member's usage into the (org, member, period) row. */
  recordOrgUsage(orgId: string, userId: string, period: string, addCents: number, addMinutes: number): Promise<void>;
  /**
   * Compute remaining member-cap + pool budget for a member in a period. Each
   * `*Remaining*` is null when that cap is unlimited, else `max(0, limit - used)`.
   * `allowed` is true unless any CAPPED unit/scope is exhausted (remaining 0); no
   * limits set ⇒ allowed true with all remaining null.
   */
  checkOrgUsageRemaining(orgId: string, userId: string, period: string): Promise<OrgUsageCheck>;
}
