// Org-shared API key resolution (Seam — web-forge ↔ AgentKitProfile, service-key auth).
//
// A team org can hold a SINGLE shared API key PER provider. At inference time, when
// a member has no BYO key of their own, Auto falls back to the org's shared key
// BEFORE the operator/platform key. The precedence is strictly:
//
//   managed (wins as today) → the user's OWN BYO key → the user's ORG key (here) →
//   operator/platform key.
//
// The org key NEVER applies in the managed path: managed billing returns first, so a
// protected/paid run (which forces managed) never reaches this resolver.
//
// P2: AgentKitProfile is the system of record for org entities (memberships, shared
// provider keys, run budgets). This resolver now calls PROFILE directly via the
// shared PROFILE_SERVICE_KEY (x-profile-service-key) and an ASSERTED userId in the
// route — no user session. It FAILS OPEN (returns undefined) on every absence/error
// so a run NEVER fails because Profile is unreachable, disabled, or unconfigured.
import {
  profileOrgRoutes,
  resolvedOrgApiKeySchema
} from "@agentkitforge/contracts";
import type { AiProviderType } from "@agentkitforge/gateway-core";
import { getProfileBaseUrl, isProfileEnabled } from "@/lib/self-host";

/** The shared web↔Profile service key (server-only). Sent as x-profile-service-key. */
function profileServiceKey(): string | undefined {
  return process.env.PROFILE_SERVICE_KEY;
}

/** Build the Profile service org-api-key resolve URL for a user + provider. Honors
 *  the Profile gate: when Profile is not configured there is no base URL → undefined. */
function resolveOrgApiKeyUrl(userId: string, providerType: AiProviderType): string | undefined {
  if (!isProfileEnabled()) return undefined;
  const base = getProfileBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${profileOrgRoutes.resolveUserOrgApiKey(userId, providerType)}`;
}

/**
 * Resolve the user's effective ORG shared key FOR A GIVEN PROVIDER TYPE
 * SERVER-TO-SERVICE (no user session), via PROFILE_SERVICE_KEY + an asserted
 * userId in the route. An org holds ONE key per provider type, so the resolve is
 * per-provider: `providerType` is the effective provider being resolved (the
 * user's selected provider, or — when none — the operator default). Profile maps
 * the user → their single team org that holds a shared key FOR THAT PROVIDER and
 * returns the decrypted key (or { found: false }).
 *
 * Returns the key only when present AND it matches the requested `providerType`;
 * otherwise undefined. FAILS OPEN — Profile disabled / unconfigured, no base URL,
 * any network error, timeout, non-2xx, or an unparseable response all yield
 * undefined so the caller falls through to the operator/platform key. A run must
 * NEVER fail because Profile is unreachable.
 */
export async function resolveOrgApiKey(
  userId: string,
  providerType: AiProviderType
): Promise<{ apiKey: string; baseUrl?: string; providerType: AiProviderType } | undefined> {
  // Local-first / Profile-absent path: skip silently (never throw).
  if (!isProfileEnabled()) return undefined;
  const key = profileServiceKey();
  if (!key || key.length === 0) return undefined;
  const url = resolveOrgApiKeyUrl(userId, providerType);
  if (!url) return undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-profile-service-key": key
      },
      cache: "no-store",
      // Short timeout: org-key resolution must never stall a run. On timeout the
      // AbortError is caught below → undefined → operator/platform fallback.
      signal: AbortSignal.timeout(5000)
    });
  } catch (cause) {
    // Network error / timeout → fall through to operator key (no key material logged).
    if (process.env.NODE_ENV !== "production") {
      console.debug("[org-key-client] resolveOrgApiKey request failed; skipping org key", cause);
    }
    return undefined;
  }

  if (!response.ok) return undefined;

  const payload = await response.json().catch(() => undefined);
  if (payload === undefined) return undefined;
  const parsed = resolvedOrgApiKeySchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const resolved = parsed.data;
  // Multi-provider: accept the org key only when it is FOUND and its providerType
  // MATCHES the provider we asked for (an org key for a different provider is not
  // usable for this run — fall through to the operator key). The contract's
  // providerType is the 5-value enum; narrow to the requested AiProviderType.
  if (
    !resolved.found ||
    !resolved.apiKey ||
    resolved.providerType !== providerType
  ) {
    return undefined;
  }
  return {
    apiKey: resolved.apiKey,
    providerType,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {})
  };
}
