// Profile org seam client (P2) — market-web → AgentKitProfile.
//
// AgentKitProfile is the system of record for org entities (orgs, memberships,
// invites, shared provider keys, run budgets). This module is the single place
// market-web talks to Profile's `profileOrgRoutes`. Two auth modes back those
// routes:
//   - TRUSTED-CONTEXT (browser-originated CRUD): x-profile-service-key +
//     x-agentkit-user-id = the actor. Profile's handler reads the actor from the
//     header and enforces owner/admin role gates.
//   - SERVICE-CONTEXT (target userId/orgId asserted in the path): only the
//     service key; used for list-my-orgs / list-invites / accept-invite.
//
// PROFILE_API_BASE_URL + PROFILE_SERVICE_KEY are server-only.

import {
  profileOrgRoutes,
  type Organization,
  type OrgMembership,
} from "@agentkitforge/contracts";

export class ProfileOrgConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileOrgConfigError";
  }
}

function getProfileBaseUrl(): string | undefined {
  return process.env.PROFILE_API_BASE_URL?.replace(/\/+$/, "");
}

function getProfileServiceKey(): string | undefined {
  return process.env.PROFILE_SERVICE_KEY;
}

/** True when the Profile org seam is wired up (both base URL + service key set). */
export function isProfileOrgConfigured(): boolean {
  return Boolean(getProfileBaseUrl()) && Boolean(getProfileServiceKey());
}

interface ProfileFetchOptions {
  method: string;
  /** When set, sent as `x-agentkit-user-id` (trusted-context actor). */
  actorUserId?: string;
  body?: unknown;
}

/**
 * Low-level Profile org request. Returns the raw `Response` (the browser-orgs
 * proxy maps status/body for the UI). Throws ProfileOrgConfigError when Profile
 * is not configured.
 */
export async function fetchProfileOrg(path: string, options: ProfileFetchOptions): Promise<Response> {
  const baseUrl = getProfileBaseUrl();
  const serviceKey = getProfileServiceKey();
  if (!baseUrl || !serviceKey) {
    throw new ProfileOrgConfigError("AgentKitProfile org seam is not configured (PROFILE_API_BASE_URL / PROFILE_SERVICE_KEY).");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-profile-service-key": serviceKey,
  };
  if (options.actorUserId) {
    headers["x-agentkit-user-id"] = options.actorUserId;
  }

  const init: RequestInit = { method: options.method, headers, cache: "no-store" };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  return fetch(`${baseUrl}${path}`, init);
}

export { profileOrgRoutes };
export type { Organization, OrgMembership };
