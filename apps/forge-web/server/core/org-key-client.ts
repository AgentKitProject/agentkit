// Org shared-API-key resolution (BYO fallback) — Seam S (web-forge ↔ market-app,
// service-key auth). Mirrors protected-kits.ts's service-call pattern exactly.
//
// When a user has NO usable BYO provider key of their own, the AI-draft path may
// fall back to their TEAM ORG's shared key before the env/platform fallback. The
// Market service maps userId → the single team org that holds a shared key and
// returns the decrypted key. This is OPTIONAL and MUST degrade gracefully: a
// disabled/unreachable Market never blocks a draft — it just yields `undefined`
// and the caller falls through to its existing fallback.
//
// Provider type is "anthropic" only (orgKeyProviderTypeSchema), so the caller must
// only apply this when the effective BYO provider is Anthropic.
import {
  marketServiceRoutes,
  marketServiceAuthHeader,
  serviceResolveOrgApiKeyRequestSchema,
  resolvedOrgApiKeySchema
} from "@agentkitforge/contracts";
import { getMarketBaseUrl, isMarketEnabled } from "@/lib/self-host";

/** Short timeout so a slow/down Market never blocks a draft. */
const ORG_KEY_TIMEOUT_MS = 4000;

export interface ResolvedOrgKey {
  apiKey: string;
  baseUrl?: string;
  providerType: "anthropic";
}

/** The shared web-forge↔market-app service key (server-only). Same key the
 *  protected-kit service path uses. */
function marketServiceKey(): string | undefined {
  return process.env.MARKET_SERVICE_KEY;
}

/** Build the Market service org-api-key URL. Requires a Market base URL
 *  (per-instance AGENTKITMARKET_BASE_URL; self-host without a Market → undefined). */
function serviceResolveOrgApiKeyUrl(): string | undefined {
  const base = getMarketBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${marketServiceRoutes.resolveOrgApiKey()}`;
}

/**
 * Resolve the user's effective ORG shared API key (decrypted) SERVER-TO-SERVICE,
 * or `undefined` when none applies. NEVER throws and NEVER blocks: any of
 * Market-disabled / no service key / no base URL / network error / non-2xx / parse
 * failure / found:false yields `undefined`, so the caller simply skips the org
 * fallback. Debug-logs errors WITHOUT any key material.
 */
export async function resolveOrgApiKey(userId: string): Promise<ResolvedOrgKey | undefined> {
  // Self-host with Market disabled → no org keys (fail closed, never phone home).
  if (!isMarketEnabled()) return undefined;
  const key = marketServiceKey();
  if (!key || key.length === 0) return undefined;
  const url = serviceResolveOrgApiKeyUrl();
  if (!url) return undefined;

  const body = serviceResolveOrgApiKeyRequestSchema.safeParse({ userId });
  if (!body.success) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ORG_KEY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [marketServiceAuthHeader]: key
      },
      body: JSON.stringify(body.data),
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
      providerType: "anthropic",
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {})
    };
  } catch {
    // Never block a draft on Market being slow/down. No key material logged.
    if (process.env.NODE_ENV !== "production") {
      console.debug("[org-key-client] resolveOrgApiKey skipped (Market error/timeout)");
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
