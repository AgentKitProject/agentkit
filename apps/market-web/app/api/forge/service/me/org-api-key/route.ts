// POST /api/forge/service/me/org-api-key — SERVICE-KEY authed resolution of the
// asserted user's effective ORG shared API key (DECRYPTED). Used by the hosted /
// self-host AgentKitAuto + Web-Forge SSR servers at inference time, AFTER a
// member's own key and BEFORE the operator key. THIRD auth path: service key only
// (NOT requireForgeUser, NOT the AuthKit cookie — CLAUDE.md hard rule #4).
//
// Unlike the entitled-kits / licensed-package service routes (which are COMMERCIAL
// — they touch entitlements/watermark), org shared keys are an OPEN-CORE feature
// that must work on self-host. So this handler is PUBLIC: it just gates on the
// shared service key and proxies to the market-core Seam-B resolver. The decrypted
// key is returned ONLY over this server-only, service-key-authenticated boundary.
import {
  marketBackendOrgRoutes,
  serviceResolveOrgApiKeyRequestSchema,
  resolvedOrgApiKeySchema
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
  const parsed = serviceResolveOrgApiKeyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let backendRes: Response;
  try {
    backendRes = await fetchAdminBackend(
      marketBackendOrgRoutes.adminResolveUserOrgApiKey(parsed.data.userId),
      { method: "GET" }
    );
  } catch {
    return Response.json({ error: "backend_unavailable" }, { status: 502 });
  }
  if (!backendRes.ok) {
    return Response.json({ error: "backend_unavailable" }, { status: 502 });
  }

  const result = resolvedOrgApiKeySchema.safeParse(await backendRes.json().catch(() => null));
  // A shape we don't recognize → treat as not-found rather than leaking anything.
  return Response.json(result.success ? result.data : { found: false });
}
