// Org-shared API key resolution (Seam S — web-forge ↔ market-app, service-key auth).
//
// A team org can hold a SINGLE shared Anthropic API key. At inference time, when a
// member has no BYO key of their own, Auto falls back to the org's shared key BEFORE
// the operator/platform key. The precedence is strictly:
//
//   managed (wins as today) → the user's OWN BYO key → the user's ORG key (here) →
//   operator/platform key.
//
// The org key NEVER applies in the managed path: managed billing returns first, so a
// protected/paid run (which forces managed) never reaches this resolver.
//
// This mirrors the SERVICE-MODE pattern in protected-kits.ts exactly: it talks to the
// Market service endpoint via the shared MARKET_SERVICE_KEY (x-agentkit-service-key)
// and an explicitly-asserted userId — no user session. It FAILS OPEN (returns
// undefined) on every absence/error so a run NEVER fails because Market is
// unreachable, disabled, or unconfigured.
import {
  marketServiceRoutes,
  marketServiceAuthHeader,
  serviceResolveOrgApiKeyRequestSchema,
  resolvedOrgApiKeySchema
} from "@agentkitforge/contracts";
import { getMarketBaseUrl, isMarketEnabled } from "@/lib/self-host";

/** The shared web-forge↔market-app service key (server-only). Same key used by
 *  protected-kits.ts; the worker NEVER holds it and NEVER calls Market directly. */
function marketServiceKey(): string | undefined {
  return process.env.MARKET_SERVICE_KEY;
}

/** Build the Market service org-api-key URL. Honors the self-host gate: when Market
 *  is disabled (self-host with no own Market) there is no base URL → undefined. */
function serviceOrgApiKeyUrl(): string | undefined {
  if (!isMarketEnabled()) return undefined;
  const base = getMarketBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${marketServiceRoutes.resolveOrgApiKey()}`;
}

/**
 * Resolve the user's effective ORG shared Anthropic key SERVER-TO-SERVICE (no user
 * session), via MARKET_SERVICE_KEY + an explicitly-asserted userId. The Market
 * service maps the user → their single team org that holds a shared key and returns
 * the decrypted key (or { found: false }).
 *
 * Returns the key only when present; otherwise undefined. FAILS OPEN — Market
 * disabled / unconfigured, no base URL, any network error, timeout, non-2xx, or an
 * unparseable response all yield undefined so the caller falls through to the
 * operator/platform key. A run must NEVER fail because Market is unreachable.
 */
export async function resolveOrgApiKey(
  userId: string
): Promise<{ apiKey: string; baseUrl?: string; providerType: "anthropic" } | undefined> {
  // Local-first / Market-absent path: skip silently (never throw).
  if (!isMarketEnabled()) return undefined;
  const key = marketServiceKey();
  if (!key || key.length === 0) return undefined;
  const url = serviceOrgApiKeyUrl();
  if (!url) return undefined;

  const body = serviceResolveOrgApiKeyRequestSchema.parse({ userId });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [marketServiceAuthHeader]: key
      },
      body: JSON.stringify(body),
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
  // Only the Anthropic provider is supported in Phase A (matches the BYO path).
  if (!resolved.found || !resolved.apiKey || resolved.providerType !== "anthropic") {
    return undefined;
  }
  return {
    apiKey: resolved.apiKey,
    providerType: "anthropic",
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {})
  };
}
