/**
 * Profile-backed OrgLookupClient (P2).
 *
 * AgentKitProfile is the system of record for org entities. The kit-coupling
 * handlers (transfer, visibility, list-org-kits gate, submission owner-org
 * resolution, publish/remove authz) resolve membership/org lookups through this
 * client instead of the local OrgRepository.
 *
 * Auth: the Profile service seam — `x-profile-service-key: PROFILE_SERVICE_KEY`.
 * The hot membership-check / resolve / list / ensure-personal-org routes Profile
 * serves are SERVICE-CONTEXT (service key only, target userId/orgId asserted in
 * the path), so no per-user header is needed.
 *
 * FAIL-CLOSED: every method THROWS on any failure (unreachable, timeout, non-2xx
 * other than the documented 404, unparseable body, missing config). The market
 * router's top-level try/catch turns a throw into a 500, so a membership-gated
 * mutation never proceeds when authz cannot be confirmed. This is the opposite of
 * the runtime org-key / run-budget RESOLVE seam (which fails open).
 */

import {
  profileOrgRoutes,
  profileOrgUsageRoutes,
  orgPrivateKitCapSchema,
  type Organization,
  type OrgMembership,
} from '@agentkitforge/contracts';
import type { OrgLookupClient } from '../../core/ports.js';

export interface ProfileOrgLookupClientConfig {
  /** Profile API base URL (e.g. the in-cluster profile service URL). */
  baseUrl: string;
  /** Shared service key sent as `x-profile-service-key`. */
  serviceKey: string;
  /** Per-request timeout (ms). Defaults to 5000. */
  timeoutMs?: number;
}

class ProfileOrgLookupError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProfileOrgLookupError';
  }
}

export function createProfileOrgLookupClient(
  config: ProfileOrgLookupClientConfig,
): OrgLookupClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 5000;

  function headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-profile-service-key': config.serviceKey,
    };
  }

  /**
   * Performs a Profile request. FAIL-CLOSED: throws on any transport/parse error
   * or non-OK status. `allow404` lets membership/org lookups translate a Profile
   * 404 into `undefined` (a legitimate "no such membership/org") WITHOUT failing
   * open — the request itself still reached Profile.
   */
  async function request(
    path: string,
    init: RequestInit,
    allow404: boolean,
  ): Promise<unknown | undefined> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: headers(),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ProfileOrgLookupError(`Profile request failed: ${path}`, cause);
    }
    if (response.status === 404 && allow404) {
      return undefined;
    }
    if (!response.ok) {
      throw new ProfileOrgLookupError(`Profile responded ${response.status} for ${path}`);
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new ProfileOrgLookupError(`Profile returned unparseable body for ${path}`, cause);
    }
  }

  function unwrapItem(payload: unknown): Record<string, unknown> | undefined {
    if (payload && typeof payload === 'object' && 'item' in payload) {
      const item = (payload as { item: unknown }).item;
      return item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
    }
    return undefined;
  }

  return {
    async getMembership(orgId, userId): Promise<OrgMembership | undefined> {
      const payload = await request(
        profileOrgRoutes.getMembership(orgId, userId),
        { method: 'GET' },
        true,
      );
      if (payload === undefined) {
        return undefined;
      }
      // Profile's hot membership check returns `{ role, status }`.
      const body = payload as { role?: unknown; status?: unknown };
      if (typeof body.role !== 'string' || typeof body.status !== 'string') {
        throw new ProfileOrgLookupError('Profile membership response missing role/status');
      }
      return {
        orgId,
        userId,
        role: body.role as OrgMembership['role'],
        status: body.status as OrgMembership['status'],
        createdAt: '',
      };
    },

    async listOrgsForUser(userId): Promise<Organization[]> {
      const payload = await request(
        profileOrgRoutes.listUserOrgs(userId),
        { method: 'GET' },
        false,
      );
      const items = (payload as { items?: unknown })?.items;
      if (!Array.isArray(items)) {
        throw new ProfileOrgLookupError('Profile listUserOrgs response missing items[]');
      }
      return items as Organization[];
    },

    async getOrg(orgId): Promise<Organization | undefined> {
      const payload = await request(profileOrgRoutes.getOrg(orgId), { method: 'GET' }, true);
      if (payload === undefined) {
        return undefined;
      }
      return unwrapItem(payload) as Organization | undefined;
    },

    async getOrgBySlug(slug): Promise<Organization | undefined> {
      const payload = await request(
        profileOrgRoutes.getOrgBySlug(slug),
        { method: 'GET' },
        true,
      );
      if (payload === undefined) {
        return undefined;
      }
      return unwrapItem(payload) as Organization | undefined;
    },

    async ensurePersonalOrg(userId, displayName): Promise<Organization> {
      const payload = await request(
        profileOrgRoutes.ensurePersonalOrg(userId),
        { method: 'POST', body: JSON.stringify({ displayName: displayName ?? userId }) },
        false,
      );
      const org = unwrapItem(payload);
      if (!org) {
        throw new ProfileOrgLookupError('Profile ensurePersonalOrg response missing item');
      }
      return org as unknown as Organization;
    },

    // FAIL-OPEN (private-kits A2): unlike the membership/org lookups above, a
    // Profile outage must NOT block set-private. Any transport/parse/non-2xx
    // failure returns undefined so the caller falls back to the env default. A
    // 200 with `maxPrivateKits: null` is an EXPLICIT "unlimited" and returns null.
    async getOrgPrivateKitCap(orgId): Promise<number | null | undefined> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${profileOrgUsageRoutes.orgPrivateKitCap(orgId)}`, {
          method: 'GET',
          headers: headers(),
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return undefined;
      }
      if (!response.ok) {
        return undefined;
      }
      try {
        const parsed = orgPrivateKitCapSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.maxPrivateKits : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
