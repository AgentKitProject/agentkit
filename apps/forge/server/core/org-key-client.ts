// Org shared-API-key resolution (BYO fallback) — Seam (web-forge ↔ AgentKitProfile,
// service-key auth).
//
// When a user has NO usable BYO provider key of their own, the AI-draft path may
// fall back to their TEAM ORG's shared key before the env/platform fallback. Profile
// maps userId → the single team org that holds a shared key FOR THAT PROVIDER and
// returns the decrypted key. This is OPTIONAL and MUST degrade gracefully: a
// disabled/unreachable Profile never blocks a draft — it just yields `undefined`
// and the caller falls through to its existing fallback.
//
// The org key is now MULTI-PROVIDER (one key per provider type), so the resolve
// is per-provider: the caller passes the effective provider's type and the
// returned key applies to THAT provider.
//
// P2: AgentKitProfile is the system of record for org entities, so this resolver
// calls Profile directly via the shared PROFILE_SERVICE_KEY (x-profile-service-key)
// and an ASSERTED userId in the route.
import {
  profileOrgRoutes,
  resolvedOrgApiKeySchema,
  type OrgKeyProviderType
} from "@agentkitforge/contracts";
import { getProfileBaseUrl, isProfileEnabled } from "@/lib/self-host";

/** Short timeout so a slow/down Profile never blocks a draft. */
const ORG_KEY_TIMEOUT_MS = 4000;

export interface ResolvedOrgKey {
  apiKey: string;
  baseUrl?: string;
  providerType: OrgKeyProviderType;
}

/** The shared web-forge↔Profile service key (server-only). Sent as x-profile-service-key. */
function profileServiceKey(): string | undefined {
  return process.env.PROFILE_SERVICE_KEY;
}

/** Build the Profile service org-api-key resolve URL for a user + provider. Requires
 *  a Profile base URL (self-host without Profile → undefined). */
function resolveOrgApiKeyUrl(userId: string, providerType: OrgKeyProviderType): string | undefined {
  const base = getProfileBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${profileOrgRoutes.resolveUserOrgApiKey(userId, providerType)}`;
}

/**
 * Resolve the user's effective ORG shared API key (decrypted) SERVER-TO-SERVICE
 * FOR THE GIVEN PROVIDER, or `undefined` when none applies. NEVER throws and
 * NEVER blocks: any of Profile-disabled / no service key / no base URL / network
 * error / non-2xx / parse failure / found:false yields `undefined`, so the caller
 * simply skips the org fallback. Debug-logs errors WITHOUT any key material.
 */
export async function resolveOrgApiKey(
  userId: string,
  providerType: OrgKeyProviderType
): Promise<ResolvedOrgKey | undefined> {
  // Self-host with Profile disabled → no org keys (fail closed, never phone home).
  if (!isProfileEnabled()) return undefined;
  const key = profileServiceKey();
  if (!key || key.length === 0) return undefined;
  const url = resolveOrgApiKeyUrl(userId, providerType);
  if (!url) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ORG_KEY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-profile-service-key": key
      },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    const payload = (await response.json().catch(() => ({}))) as unknown;
    const parsed = resolvedOrgApiKeySchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const resolved = parsed.data;
    if (!resolved.found || !resolved.apiKey || resolved.apiKey.length === 0) return undefined;
    return {
      apiKey: resolved.apiKey,
      providerType: resolved.providerType ?? providerType,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {})
    };
  } catch {
    // Never block a draft on Profile being slow/down. No key material logged.
    if (process.env.NODE_ENV !== "production") {
      console.debug("[org-key-client] resolveOrgApiKey skipped (Profile error/timeout)");
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
