// Org default run-budget resolution (Seam S — auto-web ↔ market-app, service-key
// auth). This MIRRORS org-key-client.ts exactly.
//
// An org can set ONE default per-run budget (US cents) that OVERRIDES each
// member's own default. At run-create time Auto resolves the effective budget as:
//
//   org override (here) → the user's OWN default → system fallback (50¢).
//
// This talks to the Market service endpoint via the shared MARKET_SERVICE_KEY
// (x-agentkit-service-key) and an explicitly-asserted userId — no user session.
// It FAILS OPEN (returns undefined) on every absence/error so a run NEVER fails
// because Market is unreachable, disabled, or unconfigured.
import {
  marketServiceRoutes,
  marketServiceAuthHeader,
  serviceResolveOrgRunBudgetRequestSchema,
  resolvedOrgRunBudgetSchema
} from "@agentkitforge/contracts";
import { getMarketBaseUrl, isMarketEnabled } from "@/lib/self-host";

/** The shared auto-web↔market-app service key (server-only). Same key used by
 *  org-key-client.ts; the worker NEVER holds it and NEVER calls Market directly. */
function marketServiceKey(): string | undefined {
  return process.env.MARKET_SERVICE_KEY;
}

/** Build the Market service run-budget URL. Honors the self-host gate: when
 *  Market is disabled there is no base URL → undefined. */
function serviceRunBudgetUrl(): string | undefined {
  if (!isMarketEnabled()) return undefined;
  const base = getMarketBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${marketServiceRoutes.resolveOrgRunBudget()}`;
}

/**
 * Resolve the user's effective ORG default run budget (US cents) SERVER-TO-
 * SERVICE (no user session), via MARKET_SERVICE_KEY + an explicitly-asserted
 * userId. The Market service maps the user → their single org that has a default
 * run budget set and returns it (or { found: false }).
 *
 * Returns the budget only when present; otherwise undefined. FAILS OPEN — Market
 * disabled / unconfigured, no base URL, any network error, timeout, non-2xx, or
 * an unparseable response all yield undefined so the caller falls through to the
 * user's own default. A run must NEVER fail because Market is unreachable.
 */
export async function resolveOrgRunBudget(userId: string): Promise<number | undefined> {
  // Local-first / Market-absent path: skip silently (never throw).
  if (!isMarketEnabled()) return undefined;
  const key = marketServiceKey();
  if (!key || key.length === 0) return undefined;
  const url = serviceRunBudgetUrl();
  if (!url) return undefined;

  const body = serviceResolveOrgRunBudgetRequestSchema.parse({ userId });

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
      // Short timeout: budget resolution must never stall a run. On timeout the
      // AbortError is caught below → undefined → user-default fallback.
      signal: AbortSignal.timeout(5000)
    });
  } catch (cause) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[run-budget-client] resolveOrgRunBudget request failed; skipping org budget", cause);
    }
    return undefined;
  }

  if (!response.ok) return undefined;

  const payload = await response.json().catch(() => undefined);
  if (payload === undefined) return undefined;
  const parsed = resolvedOrgRunBudgetSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const resolved = parsed.data;
  if (!resolved.found || resolved.budgetCents === undefined) {
    return undefined;
  }
  return resolved.budgetCents;
}
