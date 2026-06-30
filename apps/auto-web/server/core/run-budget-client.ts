// Org default run-budget resolution (Seam — auto-web ↔ AgentKitProfile, service-key
// auth). This MIRRORS org-key-client.ts exactly.
//
// An org can set ONE default per-run budget (US cents) that OVERRIDES each
// member's own default. At run-create time Auto resolves the effective budget as:
//
//   org override (here) → the user's OWN default → system fallback (50¢).
//
// P2: AgentKitProfile is the system of record for org entities. This talks to the
// Profile service endpoint via the shared PROFILE_SERVICE_KEY (x-profile-service-key)
// and an ASSERTED userId in the route — no user session. It FAILS OPEN (returns
// undefined) on every absence/error so a run NEVER fails because Profile is
// unreachable, disabled, or unconfigured.
import {
  profileOrgRoutes,
  resolvedOrgRunBudgetSchema
} from "@agentkitforge/contracts";
import { getProfileBaseUrl, isProfileEnabled } from "@/lib/self-host";

/** The shared auto-web↔Profile service key (server-only). Sent as x-profile-service-key. */
function profileServiceKey(): string | undefined {
  return process.env.PROFILE_SERVICE_KEY;
}

/** Build the Profile service run-budget resolve URL for a user. Honors the Profile
 *  gate: when Profile is not configured there is no base URL → undefined. */
function resolveRunBudgetUrl(userId: string): string | undefined {
  if (!isProfileEnabled()) return undefined;
  const base = getProfileBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${profileOrgRoutes.resolveUserOrgRunBudget(userId)}`;
}

/**
 * Resolve the user's effective ORG default run budget (US cents) SERVER-TO-
 * SERVICE (no user session), via PROFILE_SERVICE_KEY + an asserted userId in the
 * route. Profile maps the user → their single org that has a default run budget
 * set and returns it (or { found: false }).
 *
 * Returns the budget only when present; otherwise undefined. FAILS OPEN — Profile
 * disabled / unconfigured, no base URL, any network error, timeout, non-2xx, or
 * an unparseable response all yield undefined so the caller falls through to the
 * user's own default. A run must NEVER fail because Profile is unreachable.
 */
export async function resolveOrgRunBudget(userId: string): Promise<number | undefined> {
  // Local-first / Profile-absent path: skip silently (never throw).
  if (!isProfileEnabled()) return undefined;
  const key = profileServiceKey();
  if (!key || key.length === 0) return undefined;
  const url = resolveRunBudgetUrl(userId);
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
