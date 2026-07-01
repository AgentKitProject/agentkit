// market-web's OrgLookupClient → AgentKitProfile (P2).
//
// market-core's kit-coupling handlers (transfer/visibility authz, list-org-kits
// gate, submission owner-org resolution, publish/remove authz) resolve org
// membership from an injected OrgLookupClient that fails CLOSED. AgentKitProfile
// is the org system of record, so this implementation calls Profile's service
// seam (x-profile-service-key, target ids asserted in the path) and THROWS on any
// failure so authz never proceeds when Profile is unreachable.
//
// NOTE on wiring: in the current architecture market-web does NOT itself
// construct market-core's router — it proxies org CRUD to AgentKitProfile (see
// lib/browser-orgs.ts) and kit submit/transfer/visibility to the market backend /
// market-core entrypoints, which build their OWN Profile-backed OrgLookupClient
// (see packages/market-core/src/entrypoints/{server,lambda}.ts). This module
// provides the same Profile-backed client shape for any future in-process
// market-core composition inside market-web, satisfying the "the OrgLookupClient
// market-web wires is Profile-backed" contract without adding a market-core dep.

import {
  profileOrgRoutes,
  profileOrgUsageRoutes,
  orgPrivateKitCapSchema,
  type Organization,
  type OrgMembership,
} from "@agentkitforge/contracts";

/** Minimal structural OrgLookupClient (mirrors @agentkitforge/market-core's port). */
export interface OrgLookupClient {
  getMembership(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  listOrgsForUser(userId: string): Promise<Organization[]>;
  getOrg(orgId: string): Promise<Organization | undefined>;
  getOrgBySlug(slug: string): Promise<Organization | undefined>;
  ensurePersonalOrg(userId: string, displayName?: string): Promise<Organization>;
  /** Org's configured max private-kit count. FAIL-OPEN: undefined on any error (private-kits A2). */
  getOrgPrivateKitCap(orgId: string): Promise<number | null | undefined>;
}

class ProfileOrgLookupError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ProfileOrgLookupError";
  }
}

/**
 * Build the Profile-backed OrgLookupClient from market-web's server env
 * (PROFILE_API_BASE_URL + PROFILE_SERVICE_KEY). Returns undefined when either is
 * unset. Every method FAILS CLOSED (throws) on transport/parse/non-2xx errors.
 */
export function buildProfileOrgLookupClient(): OrgLookupClient | undefined {
  const baseUrl = process.env.PROFILE_API_BASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.PROFILE_SERVICE_KEY?.trim();
  if (!baseUrl || !serviceKey) {
    return undefined;
  }

  const headers = (): Record<string, string> => ({
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-profile-service-key": serviceKey,
  });

  async function request(path: string, init: RequestInit, allow404: boolean): Promise<unknown | undefined> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: headers(),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
    } catch (cause) {
      throw new ProfileOrgLookupError(`Profile request failed: ${path}`, cause);
    }
    if (response.status === 404 && allow404) return undefined;
    if (!response.ok) throw new ProfileOrgLookupError(`Profile responded ${response.status} for ${path}`);
    try {
      return await response.json();
    } catch (cause) {
      throw new ProfileOrgLookupError(`Profile returned unparseable body for ${path}`, cause);
    }
  }

  function unwrapItem(payload: unknown): Record<string, unknown> | undefined {
    if (payload && typeof payload === "object" && "item" in payload) {
      const item = (payload as { item: unknown }).item;
      return item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    }
    return undefined;
  }

  return {
    async getMembership(orgId, userId) {
      const payload = await request(profileOrgRoutes.getMembership(orgId, userId), { method: "GET" }, true);
      if (payload === undefined) return undefined;
      const body = payload as { role?: unknown; status?: unknown };
      if (typeof body.role !== "string" || typeof body.status !== "string") {
        throw new ProfileOrgLookupError("Profile membership response missing role/status");
      }
      return {
        orgId,
        userId,
        role: body.role as OrgMembership["role"],
        status: body.status as OrgMembership["status"],
        createdAt: "",
      };
    },
    async listOrgsForUser(userId) {
      const payload = await request(profileOrgRoutes.listUserOrgs(userId), { method: "GET" }, false);
      const items = (payload as { items?: unknown })?.items;
      if (!Array.isArray(items)) throw new ProfileOrgLookupError("Profile listUserOrgs response missing items[]");
      return items as Organization[];
    },
    async getOrg(orgId) {
      const payload = await request(profileOrgRoutes.getOrg(orgId), { method: "GET" }, true);
      if (payload === undefined) return undefined;
      return unwrapItem(payload) as Organization | undefined;
    },
    async getOrgBySlug(slug) {
      const payload = await request(profileOrgRoutes.getOrgBySlug(slug), { method: "GET" }, true);
      if (payload === undefined) return undefined;
      return unwrapItem(payload) as Organization | undefined;
    },
    async ensurePersonalOrg(userId, displayName) {
      const payload = await request(
        profileOrgRoutes.ensurePersonalOrg(userId),
        { method: "POST", body: JSON.stringify({ displayName: displayName ?? userId }) },
        false,
      );
      const org = unwrapItem(payload);
      if (!org) throw new ProfileOrgLookupError("Profile ensurePersonalOrg response missing item");
      return org as unknown as Organization;
    },
    // FAIL-OPEN (private-kits A2): a Profile outage must not block set-private, so
    // any error returns undefined (caller falls back to the env default).
    async getOrgPrivateKitCap(orgId) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${profileOrgUsageRoutes.orgPrivateKitCap(orgId)}`, {
          method: "GET",
          headers: headers(),
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        return undefined;
      }
      if (!response.ok) return undefined;
      try {
        const parsed = orgPrivateKitCapSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.maxPrivateKits : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
