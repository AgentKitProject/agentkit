// Org monthly-usage seam (org budgets v2 — auto-web ↔ AgentKitProfile, service-key
// auth). This MIRRORS run-budget-client.ts exactly.
//
// An org can set monthly usage limits (a shared pool + per-member caps, in cents
// and active-minutes). Auto enforces them with two hot-paths, both keyed by the
// USER (Profile resolves the user's single org with monthly limits set):
//
//   - checkOrgUsage(userId, period): a PRE-run gate — block a run only when the
//     org's limit is exhausted (`check.allowed === false`).
//   - recordOrgUsage(userId, period, cents, minutes): a POST-run hook — accumulate
//     the finished run's spend + active-minutes into the (org, member, period) row.
//
// P2: AgentKitProfile is the system of record for org entities. This talks to the
// Profile service endpoint via the shared PROFILE_SERVICE_KEY (x-profile-service-key)
// and an ASSERTED userId in the route — no user session. It FAILS OPEN on every
// absence/error: the check returns undefined (the gate proceeds) and the record is
// best-effort (it never throws). A run must NEVER fail because Profile is
// unreachable, disabled, or unconfigured.
import {
  profileOrgRoutes,
  resolvedUserOrgUsageCheckSchema,
  type OrgUsageCheck
} from "@agentkitforge/contracts";
import { getProfileBaseUrl, isProfileEnabled } from "@/lib/self-host";

/** The shared auto-web↔Profile service key (server-only). Sent as x-profile-service-key. */
function profileServiceKey(): string | undefined {
  return process.env.PROFILE_SERVICE_KEY;
}

/** Build a Profile service URL from a path, honoring the Profile gate (no base → undefined). */
function profileUrl(path: string): string | undefined {
  if (!isProfileEnabled()) return undefined;
  const base = getProfileBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}${path}`;
}

/**
 * Check the user's effective ORG monthly usage (cents + active-minutes) SERVER-TO-
 * SERVICE (no user session), via PROFILE_SERVICE_KEY + an asserted userId in the
 * route. Profile maps the user → their single org with monthly limits set and
 * returns its OrgUsageCheck.
 *
 * Returns the resolved `{ found, check? }` when present; otherwise undefined. FAILS
 * OPEN — Profile disabled / unconfigured, no base URL, missing key, any network
 * error, timeout, non-2xx, or an unparseable response all yield undefined so the
 * caller PROCEEDS with the run. A run must NEVER fail because Profile is unreachable.
 */
export async function checkOrgUsage(
  userId: string,
  period: string
): Promise<{ found: boolean; check?: OrgUsageCheck } | undefined> {
  // Local-first / Profile-absent path: skip silently (never throw).
  if (!isProfileEnabled()) return undefined;
  const key = profileServiceKey();
  if (!key || key.length === 0) return undefined;
  const base = profileUrl(profileOrgRoutes.resolveUserOrgUsageCheck(userId));
  if (!base) return undefined;
  const url = `${base}?period=${encodeURIComponent(period)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-profile-service-key": key
      },
      cache: "no-store",
      // Short timeout: the usage gate must never stall a run. On timeout the
      // AbortError is caught below → undefined → the run proceeds.
      signal: AbortSignal.timeout(5000)
    });
  } catch (cause) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[org-usage-client] checkOrgUsage request failed; skipping org usage gate", cause);
    }
    return undefined;
  }

  if (!response.ok) return undefined;

  const payload = await response.json().catch(() => undefined);
  if (payload === undefined) return undefined;
  const parsed = resolvedUserOrgUsageCheckSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const resolved = parsed.data;
  return resolved.check !== undefined
    ? { found: resolved.found, check: resolved.check }
    : { found: resolved.found };
}

/**
 * Record a finished run's usage into the user's ORG monthly-usage row, SERVER-TO-
 * SERVICE. Profile maps the user → their single org with monthly limits set and
 * accumulates the spend + active-minutes for the period.
 *
 * BEST-EFFORT: swallows ALL errors and never throws. Governance accounting must
 * never affect the run result. A no-op when Profile is disabled / unconfigured /
 * unreachable, or when the user has no single org with limits.
 */
export async function recordOrgUsage(
  userId: string,
  period: string,
  addCents: number,
  addMinutes: number
): Promise<void> {
  try {
    if (!isProfileEnabled()) return;
    const key = profileServiceKey();
    if (!key || key.length === 0) return;
    const url = profileUrl(profileOrgRoutes.recordUserOrgUsage(userId));
    if (!url) return;

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-profile-service-key": key
      },
      body: JSON.stringify({ period, addCents, addMinutes }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
  } catch (cause) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[org-usage-client] recordOrgUsage failed; skipping (best-effort)", cause);
    }
  }
}
