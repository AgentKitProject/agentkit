import { randomUUID } from "node:crypto";
import type {
  Organization,
  OrgInvite,
  OrgMembership,
  OrgMonthlyLimits,
  OrgMonthlyLimitsRecord,
  OrgProviderKeyRecord,
  OrgRole,
  OrgRunBudgetRecord,
  OrgStore,
  OrgUsageCheck,
  OrgUsageSummary,
} from "./org-store.ts";

/**
 * Postgres-backed OrgStore. Ported from agentkitmarket-core's
 * `createPostgresOrgRepository` (adapters/selfhost/postgres.ts) MINUS the
 * kit-coupled methods. Conventions mirror PostgresProfileStore: a minimal
 * structural `PgQueryable` (+ `connect()` for transactions) so the `pg-mem` test
 * Pool satisfies it directly.
 */

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PgPoolClient extends PgQueryable {
  release(): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
}

// --- pure slug helpers (ported verbatim from market-core services/orgs.ts) ------

/** lowercases + hyphenates, mirroring market-core `slugifyForUrl`. */
function slugifyForUrl(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agentkit";
}

/** Returns `base` if free, else the first `base-2`, `base-3`, ... not in `taken`. */
function dedupeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set<string>(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** Base slug for a user's personal org (display-name based, stable per-user fallback). */
function personalOrgSlugBase(displayName: string, userId: string): string {
  const fromName = slugifyForUrl(displayName);
  if (fromName && fromName !== "agentkit") {
    return fromName;
  }
  return slugifyForUrl(`user-${userId}`);
}

// --- email-invite sentinel (ported verbatim from market-core postgres adapter) --

const EMAIL_INVITE_USER_ID_PREFIX = "email#";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailInviteUserId(email: string): string {
  return `${EMAIL_INVITE_USER_ID_PREFIX}${normalizeEmail(email)}`;
}

// --- row mappers ----------------------------------------------------------------

function str(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function rowToOrganization(r: Record<string, unknown>): Organization {
  const row = r as {
    org_id: string; slug: string; display_name: string; type: Organization["type"]; owner_user_id: string;
    handle: string | null; avatar_initials: string | null; verified: boolean | null;
    workos_organization_id: string | null; created_at: string; updated_at: string;
  };
  return {
    orgId: row.org_id,
    slug: row.slug,
    displayName: row.display_name,
    type: row.type,
    ownerUserId: row.owner_user_id,
    handle: str(row.handle),
    avatarInitials: str(row.avatar_initials),
    verified: row.verified === null || row.verified === undefined ? undefined : row.verified,
    workosOrganizationId: row.workos_organization_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMembership(r: Record<string, unknown>): OrgMembership {
  const row = r as {
    org_id: string; user_id: string; role: OrgMembership["role"]; status: OrgMembership["status"];
    invited_by_user_id: string | null; created_at: string;
  };
  return {
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    invitedByUserId: str(row.invited_by_user_id),
    createdAt: row.created_at,
  };
}

function rowToInvite(r: Record<string, unknown>): OrgInvite {
  const row = r as {
    org_id: string; user_id: string | null; email: string | null; role: OrgInvite["role"];
    invited_by_user_id: string; created_at: string;
  };
  const userId = str(row.user_id);
  return {
    orgId: row.org_id,
    userId: userId && userId.startsWith(EMAIL_INVITE_USER_ID_PREFIX) ? undefined : userId,
    email: str(row.email),
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at,
  };
}

function rowToProviderKey(r: Record<string, unknown>): OrgProviderKeyRecord {
  const row = r as {
    org_id: string; provider_type: OrgProviderKeyRecord["providerType"]; api_key_ciphertext: string;
    base_url: string | null; updated_by_user_id: string; updated_at: string;
  };
  return {
    orgId: row.org_id,
    providerType: row.provider_type,
    apiKeyCiphertext: row.api_key_ciphertext,
    baseUrl: row.base_url ?? undefined,
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at,
  };
}

function rowToRunBudget(r: Record<string, unknown>): OrgRunBudgetRecord {
  const row = r as {
    org_id: string; budget_cents: number | string; updated_by_user_id: string; updated_at: string;
  };
  return {
    orgId: row.org_id,
    budgetCents: Number(row.budget_cents),
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at,
  };
}

/** Coerces a nullable numeric column to `number | null` (Postgres may return strings). */
function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function rowToMonthlyLimits(r: Record<string, unknown>): OrgMonthlyLimitsRecord {
  const row = r as {
    org_id: string;
    pool_cents: number | string | null;
    pool_minutes: number | string | null;
    member_cap_cents: number | string | null;
    member_cap_minutes: number | string | null;
    max_private_kits: number | string | null;
    updated_by_user_id: string;
    updated_at: string;
  };
  return {
    orgId: row.org_id,
    limits: {
      poolCents: numOrNull(row.pool_cents),
      poolMinutes: numOrNull(row.pool_minutes),
      memberCapCents: numOrNull(row.member_cap_cents),
      memberCapMinutes: numOrNull(row.member_cap_minutes),
      maxPrivateKits: numOrNull(row.max_private_kits),
    },
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at,
  };
}

/** remaining for one capped unit: null when unlimited, else max(0, limit - used). */
function remaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(0, limit - used);
}

export class PostgresOrgStore implements OrgStore {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  private async uniqueSlug(client: PgQueryable, base: string): Promise<string> {
    const existing = await client.query(
      `SELECT slug FROM organizations WHERE slug = $1 OR slug LIKE $2`,
      [base, `${base}-%`],
    );
    return dedupeSlug(base, existing.rows.map((r) => r.slug as string));
  }

  private async insertOrgWithOwner(input: {
    displayName: string;
    ownerUserId: string;
    type: "personal" | "team";
    slug?: string;
    handle?: string;
  }): Promise<Organization> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = new Date().toISOString();
      const base = input.slug && input.slug.trim() ? slugifyForUrl(input.slug) : slugifyForUrl(input.displayName);
      const slug = await this.uniqueSlug(client, base);
      const org: Organization = {
        orgId: `org_${randomUUID()}`,
        slug,
        displayName: input.displayName,
        type: input.type,
        ownerUserId: input.ownerUserId,
        handle: input.handle,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `INSERT INTO organizations
           (org_id, slug, display_name, type, owner_user_id, handle, avatar_initials, verified, workos_organization_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [org.orgId, org.slug, org.displayName, org.type, org.ownerUserId, org.handle ?? null, null, null, null, org.createdAt, org.updatedAt],
      );
      await client.query(
        `INSERT INTO org_memberships (org_id, user_id, role, status, invited_by_user_id, created_at)
         VALUES ($1,$2,'owner','active',NULL,$3)`,
        [org.orgId, org.ownerUserId, now],
      );
      await client.query("COMMIT");
      return org;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createOrg(input: {
    displayName: string;
    ownerUserId: string;
    type?: "personal" | "team";
    slug?: string;
    handle?: string;
  }): Promise<Organization> {
    return this.insertOrgWithOwner({
      displayName: input.displayName,
      ownerUserId: input.ownerUserId,
      type: input.type ?? "team",
      slug: input.slug,
      handle: input.handle,
    });
  }

  async getOrg(orgId: string): Promise<Organization | undefined> {
    const result = await this.pool.query(`SELECT * FROM organizations WHERE org_id = $1`, [orgId]);
    return result.rows[0] ? rowToOrganization(result.rows[0]) : undefined;
  }

  async getOrgBySlug(slug: string): Promise<Organization | undefined> {
    const result = await this.pool.query(`SELECT * FROM organizations WHERE slug = $1 LIMIT 1`, [slug]);
    return result.rows[0] ? rowToOrganization(result.rows[0]) : undefined;
  }

  async ensurePersonalOrg(userId: string, displayName: string): Promise<Organization> {
    const existing = await this.pool.query(
      `SELECT * FROM organizations WHERE owner_user_id = $1 AND type = 'personal' LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) {
      return rowToOrganization(existing.rows[0]);
    }
    return this.insertOrgWithOwner({
      displayName,
      ownerUserId: userId,
      type: "personal",
      slug: personalOrgSlugBase(displayName, userId),
    });
  }

  async listOrgsForUser(userId: string): Promise<Organization[]> {
    const result = await this.pool.query(
      `SELECT o.* FROM organizations o
         JOIN org_memberships m ON m.org_id = o.org_id
         WHERE m.user_id = $1 AND m.status <> 'removed'
         ORDER BY o.created_at`,
      [userId],
    );
    return result.rows.map(rowToOrganization);
  }

  async getMembership(orgId: string, userId: string): Promise<OrgMembership | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM org_memberships WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    return result.rows[0] ? rowToMembership(result.rows[0]) : undefined;
  }

  async listMembers(orgId: string): Promise<OrgMembership[]> {
    const result = await this.pool.query(
      `SELECT * FROM org_memberships WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return result.rows.map(rowToMembership);
  }

  async addMember(orgId: string, userId: string, role: OrgRole, invitedBy: string): Promise<OrgMembership> {
    const now = new Date().toISOString();
    const membership: OrgMembership = {
      orgId, userId, role, status: "invited", invitedByUserId: invitedBy, createdAt: now,
    };
    await this.pool.query(
      `INSERT INTO org_memberships (org_id, user_id, role, status, invited_by_user_id, created_at)
       VALUES ($1,$2,$3,'invited',$4,$5)
       ON CONFLICT (org_id, user_id) DO UPDATE SET
         role = EXCLUDED.role, status = 'invited', invited_by_user_id = EXCLUDED.invited_by_user_id`,
      [orgId, userId, role, invitedBy, now],
    );
    await this.pool.query(
      `INSERT INTO org_invites (org_id, user_id, email, role, invited_by_user_id, created_at)
       VALUES ($1,$2,NULL,$3,$4,$5)
       ON CONFLICT (org_id, user_id) DO UPDATE SET
         role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id`,
      [orgId, userId, role, invitedBy, now],
    );
    return membership;
  }

  async acceptInvite(orgId: string, userId: string): Promise<OrgMembership | undefined> {
    const result = await this.pool.query(
      `UPDATE org_memberships SET status = 'active'
         WHERE org_id = $1 AND user_id = $2 AND status = 'invited'
         RETURNING *`,
      [orgId, userId],
    );
    if (!result.rows[0]) {
      return undefined;
    }
    await this.pool.query(`DELETE FROM org_invites WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    return rowToMembership(result.rows[0]);
  }

  async listInvitesForUser(userId: string): Promise<OrgInvite[]> {
    const result = await this.pool.query(
      `SELECT * FROM org_invites WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return result.rows.map(rowToInvite);
  }

  async createEmailInvite(orgId: string, email: string, role: OrgRole, invitedBy: string): Promise<OrgInvite> {
    const now = new Date().toISOString();
    const normalized = normalizeEmail(email);
    const sentinelUserId = emailInviteUserId(normalized);
    await this.pool.query(
      `INSERT INTO org_invites (org_id, user_id, email, role, invited_by_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, user_id) DO UPDATE SET
         role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id`,
      [orgId, sentinelUserId, normalized, role, invitedBy, now],
    );
    return { orgId, email: normalized, role, invitedByUserId: invitedBy, createdAt: now };
  }

  async listInvitesByEmail(email: string): Promise<OrgInvite[]> {
    const result = await this.pool.query(
      `SELECT * FROM org_invites WHERE lower(email) = $1 ORDER BY created_at`,
      [normalizeEmail(email)],
    );
    return result.rows.map(rowToInvite);
  }

  async claimInvitesByEmail(email: string, userId: string): Promise<OrgMembership[]> {
    const normalized = normalizeEmail(email);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invites = await client.query(
        `SELECT * FROM org_invites WHERE lower(email) = $1 ORDER BY created_at`,
        [normalized],
      );
      const memberships: OrgMembership[] = [];
      for (const invite of invites.rows) {
        const orgId = invite.org_id as string;
        // Idempotent: skip orgs the user is already an active member of.
        const existing = await client.query(
          `SELECT status FROM org_memberships WHERE org_id = $1 AND user_id = $2`,
          [orgId, userId],
        );
        if (!existing.rows[0] || existing.rows[0].status !== "active") {
          const now = new Date().toISOString();
          const result = await client.query(
            `INSERT INTO org_memberships (org_id, user_id, role, status, invited_by_user_id, created_at)
             VALUES ($1,$2,$3,'active',$4,$5)
             ON CONFLICT (org_id, user_id) DO UPDATE SET
               role = EXCLUDED.role, status = 'active', invited_by_user_id = EXCLUDED.invited_by_user_id
             RETURNING *`,
            [orgId, userId, invite.role, invite.invited_by_user_id, now],
          );
          memberships.push(rowToMembership(result.rows[0]));
        }
        await client.query(
          `DELETE FROM org_invites WHERE org_id = $1 AND user_id = $2`,
          [orgId, invite.user_id],
        );
      }
      await client.query("COMMIT");
      return memberships;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE org_memberships SET status = 'removed' WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    await this.pool.query(`DELETE FROM org_invites WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  }

  async deleteOrg(orgId: string): Promise<void> {
    await this.pool.query(`DELETE FROM org_provider_keys WHERE org_id = $1`, [orgId]);
    await this.pool.query(`DELETE FROM org_run_budgets WHERE org_id = $1`, [orgId]);
    await this.pool.query(`DELETE FROM org_monthly_limits WHERE org_id = $1`, [orgId]);
    await this.pool.query(`DELETE FROM org_usage WHERE org_id = $1`, [orgId]);
    await this.pool.query(`DELETE FROM org_invites WHERE org_id = $1`, [orgId]);
    await this.pool.query(`DELETE FROM org_memberships WHERE org_id = $1`, [orgId]);
    await this.pool.query(`DELETE FROM organizations WHERE org_id = $1`, [orgId]);
  }

  async setOrgProviderKey(orgId: string, input: {
    providerType: OrgProviderKeyRecord["providerType"];
    apiKeyCiphertext: string;
    baseUrl?: string;
    updatedByUserId: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO org_provider_keys (org_id, provider_type, api_key_ciphertext, base_url, updated_by_user_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, provider_type) DO UPDATE SET
         api_key_ciphertext = EXCLUDED.api_key_ciphertext,
         base_url = EXCLUDED.base_url,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at`,
      [orgId, input.providerType, input.apiKeyCiphertext, input.baseUrl ?? null, input.updatedByUserId, now],
    );
  }

  async getOrgProviderKey(
    orgId: string,
    providerType: OrgProviderKeyRecord["providerType"],
  ): Promise<OrgProviderKeyRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM org_provider_keys WHERE org_id = $1 AND provider_type = $2`,
      [orgId, providerType],
    );
    return result.rows[0] ? rowToProviderKey(result.rows[0]) : undefined;
  }

  async listOrgProviderKeys(orgId: string): Promise<OrgProviderKeyRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM org_provider_keys WHERE org_id = $1 ORDER BY provider_type`,
      [orgId],
    );
    return result.rows.map(rowToProviderKey);
  }

  async clearOrgProviderKey(orgId: string, providerType: OrgProviderKeyRecord["providerType"]): Promise<void> {
    await this.pool.query(
      `DELETE FROM org_provider_keys WHERE org_id = $1 AND provider_type = $2`,
      [orgId, providerType],
    );
  }

  async setOrgRunBudget(orgId: string, input: { budgetCents: number; updatedByUserId: string }): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO org_run_budgets (org_id, budget_cents, updated_by_user_id, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id) DO UPDATE SET
         budget_cents = EXCLUDED.budget_cents,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at`,
      [orgId, input.budgetCents, input.updatedByUserId, now],
    );
  }

  async getOrgRunBudget(orgId: string): Promise<OrgRunBudgetRecord | undefined> {
    const result = await this.pool.query(`SELECT * FROM org_run_budgets WHERE org_id = $1`, [orgId]);
    return result.rows[0] ? rowToRunBudget(result.rows[0]) : undefined;
  }

  async clearOrgRunBudget(orgId: string): Promise<void> {
    await this.pool.query(`DELETE FROM org_run_budgets WHERE org_id = $1`, [orgId]);
  }

  // === org monthly limits + usage (org budgets v2) ==============================

  async getOrgMonthlyLimits(orgId: string): Promise<OrgMonthlyLimitsRecord | undefined> {
    const result = await this.pool.query(`SELECT * FROM org_monthly_limits WHERE org_id = $1`, [orgId]);
    return result.rows[0] ? rowToMonthlyLimits(result.rows[0]) : undefined;
  }

  async setOrgMonthlyLimits(
    orgId: string,
    input: { limits: OrgMonthlyLimits; updatedByUserId: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    const { poolCents, poolMinutes, memberCapCents, memberCapMinutes, maxPrivateKits } = input.limits;
    await this.pool.query(
      `INSERT INTO org_monthly_limits
         (org_id, pool_cents, pool_minutes, member_cap_cents, member_cap_minutes, max_private_kits, updated_by_user_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id) DO UPDATE SET
         pool_cents = EXCLUDED.pool_cents,
         pool_minutes = EXCLUDED.pool_minutes,
         member_cap_cents = EXCLUDED.member_cap_cents,
         member_cap_minutes = EXCLUDED.member_cap_minutes,
         max_private_kits = EXCLUDED.max_private_kits,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at`,
      [orgId, poolCents, poolMinutes, memberCapCents, memberCapMinutes, maxPrivateKits, input.updatedByUserId, now],
    );
  }

  async clearOrgMonthlyLimits(orgId: string): Promise<void> {
    await this.pool.query(`DELETE FROM org_monthly_limits WHERE org_id = $1`, [orgId]);
  }

  async getOrgUsageSummary(orgId: string, period: string): Promise<OrgUsageSummary> {
    const result = await this.pool.query(
      `SELECT user_id, spent_cents, active_minutes FROM org_usage
         WHERE org_id = $1 AND period = $2 ORDER BY user_id`,
      [orgId, period],
    );
    let orgTotalCents = 0;
    let orgTotalMinutes = 0;
    const members = result.rows.map((r) => {
      const row = r as { user_id: string; spent_cents: number | string; active_minutes: number | string };
      const spentCents = Number(row.spent_cents);
      const activeMinutes = Number(row.active_minutes);
      orgTotalCents += spentCents;
      orgTotalMinutes += activeMinutes;
      return { userId: row.user_id, spentCents, activeMinutes };
    });
    return { period, orgTotalCents, orgTotalMinutes, members };
  }

  async getMemberUsage(
    orgId: string,
    userId: string,
    period: string,
  ): Promise<{ spentCents: number; activeMinutes: number }> {
    const result = await this.pool.query(
      `SELECT spent_cents, active_minutes FROM org_usage
         WHERE org_id = $1 AND user_id = $2 AND period = $3`,
      [orgId, userId, period],
    );
    const row = result.rows[0] as { spent_cents: number | string; active_minutes: number | string } | undefined;
    if (!row) {
      return { spentCents: 0, activeMinutes: 0 };
    }
    return { spentCents: Number(row.spent_cents), activeMinutes: Number(row.active_minutes) };
  }

  async recordOrgUsage(
    orgId: string,
    userId: string,
    period: string,
    addCents: number,
    addMinutes: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO org_usage (org_id, user_id, period, spent_cents, active_minutes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, user_id, period) DO UPDATE SET
         spent_cents = org_usage.spent_cents + EXCLUDED.spent_cents,
         active_minutes = org_usage.active_minutes + EXCLUDED.active_minutes,
         updated_at = EXCLUDED.updated_at`,
      [orgId, userId, period, addCents, addMinutes, now],
    );
  }

  async checkOrgUsageRemaining(orgId: string, userId: string, period: string): Promise<OrgUsageCheck> {
    const limitsRecord = await this.getOrgMonthlyLimits(orgId);
    // No limits configured → everything unlimited.
    if (!limitsRecord) {
      return {
        allowed: true,
        memberRemainingCents: null,
        memberRemainingMinutes: null,
        poolRemainingCents: null,
        poolRemainingMinutes: null,
      };
    }
    const { limits } = limitsRecord;
    const member = await this.getMemberUsage(orgId, userId, period);
    const summary = await this.getOrgUsageSummary(orgId, period);

    const memberRemainingCents = remaining(limits.memberCapCents, member.spentCents);
    const memberRemainingMinutes = remaining(limits.memberCapMinutes, member.activeMinutes);
    const poolRemainingCents = remaining(limits.poolCents, summary.orgTotalCents);
    const poolRemainingMinutes = remaining(limits.poolMinutes, summary.orgTotalMinutes);

    // Allowed unless any CAPPED unit/scope is exhausted (remaining 0). Null (unlimited) never blocks.
    const allowed = [memberRemainingCents, memberRemainingMinutes, poolRemainingCents, poolRemainingMinutes].every(
      (value) => value === null || value > 0,
    );

    return { allowed, memberRemainingCents, memberRemainingMinutes, poolRemainingCents, poolRemainingMinutes };
  }
}
