// POST /api/forge/service/me/run-budget — SERVICE-KEY authed resolution of the
// asserted user's effective ORG default run budget. Used by the hosted /
// self-host AgentKitAuto SSR server at run-create time, AFTER the user's own
// default and BEFORE the system fallback. THIRD auth path: service key only
// (NOT requireForgeUser, NOT the AuthKit cookie — CLAUDE.md hard rule #4).
//
// Like the org shared API key resolve route, the org default run budget is an
// OPEN-CORE feature that must work on self-host. So this handler is PUBLIC: it
// gates on the shared service key and proxies to the market-core Seam-B resolver.
import {
  marketBackendOrgRoutes,
  serviceResolveOrgRunBudgetRequestSchema,
  resolvedOrgRunBudgetSchema
} from "@agentkitforge/contracts";
import { requireServiceKey, ServiceAuthError } from "@/lib/service-auth";
import { fetchAdminBackend } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Service-key gate: 503 when MARKET_SERVICE_KEY is unset (feature disabled —
  // the caller fails open), 401 on a bad key.
  try {
    requireServiceKey(request);
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      return Response.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const parsed = serviceResolveOrgRunBudgetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let backendRes: Response;
  try {
    backendRes = await fetchAdminBackend(
      marketBackendOrgRoutes.adminResolveUserOrgRunBudget(parsed.data.userId),
      { method: "GET" }
    );
  } catch {
    return Response.json({ error: "backend_unavailable" }, { status: 502 });
  }
  if (!backendRes.ok) {
    return Response.json({ error: "backend_unavailable" }, { status: 502 });
  }

  const result = resolvedOrgRunBudgetSchema.safeParse(await backendRes.json().catch(() => null));
  // A shape we don't recognize → treat as not-found rather than leaking anything.
  return Response.json(result.success ? result.data : { found: false });
}
