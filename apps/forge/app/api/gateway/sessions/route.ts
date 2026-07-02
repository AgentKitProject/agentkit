// POST /api/gateway/sessions — create a managed gateway streaming session.
//
// Body: {
//   kitId, billing: "managed", model?,
//   // Tier-3 PROTECTED (paid / online-only Market) kit selector:
//   source?: "market", slug?, marketBaseUrl?
// }
// Auth is the AuthKit cookie session (requireUserForApi); the session is scoped
// to the signed-in user. Returns the opaque session handle (NEVER the injected
// system prompt).
//
// KIT-TYPE CLASSIFICATION: when a Market kit is identified (source/slug) we ask
// Market whether it is PROTECTED (paid / online-only). For a protected kit we:
//   - IGNORE any client-provided context (the prompt is fetched server-side),
//   - FORCE billing:"managed" (BYO would leak the prompt via the buyer's console),
//   - inject a Market ENTITLEMENT CHECK → create is denied 403 { code:
//     "not_entitled" } when the user holds no active entitlement,
//   - tag the session with a `protected:` systemPromptRef so each turn fetches the
//     kit content server-side, entitlement-gated, in-memory only.
// Owned/local/free kits keep the existing KitStore behavior unchanged.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  classifyWebKit,
  handleGatewayRequest,
  type GatewayCreateOpts
} from "@/server/core/gateway-sessions";
import { MANAGED_DEFAULT_MODEL, isManagedModel } from "@/server/core/managed-models";
import { isManagedInferenceEnabled } from "@/lib/self-host";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Managed gateway inference is OFF on self-host (BYO-key only). Run / Chat on
  // self-host uses the BYO path; the managed session endpoint is disabled.
  if (!isManagedInferenceEnabled()) {
    return Response.json(
      { error: "managed_disabled", message: "Managed inference is not available on this instance." },
      { status: 404 }
    );
  }
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as {
    kitId?: string;
    billing?: string;
    model?: string;
    source?: string;
    slug?: string;
    marketBaseUrl?: string;
  };
  const model = isManagedModel(body.model) ? body.model! : MANAGED_DEFAULT_MODEL;

  // Classify Market kits. A protected kit overrides client billing/context.
  let createBody: Record<string, unknown> = {
    kitId: body.kitId,
    // Web is managed-only this pass; the router validates the billing field.
    billing: body.billing ?? "managed"
  };
  let opts: GatewayCreateOpts | undefined;
  if (body.source === "market" && body.slug) {
    const ref = {
      slug: body.slug,
      ...(body.kitId ? { kitId: body.kitId } : {}),
      ...(body.marketBaseUrl ? { marketBaseUrl: body.marketBaseUrl } : {})
    };
    const classified = await classifyWebKit(ref);
    if (classified.isProtected) {
      // Protected: server owns the prompt + billing. Ignore any client context.
      createBody = {
        kitId: body.kitId,
        kitSlug: body.slug,
        billing: "managed",
        systemPromptRef: classified.systemPromptRef
      };
      opts = { entitlementCheck: classified.entitlementCheck };
    }
  }

  // Create returns a JSON GatewayResponse (no stream); drive the router directly
  // so we can map the entitlement-denied error to the public 403 contract.
  const res = await handleGatewayRequest(
    { method: "POST", path: "/gateway/sessions", body: createBody, userId },
    // Create never streams; supply an inert emitter.
    () => ({ emit: () => {}, close: () => {} }),
    model,
    opts
  );

  if (res.kind === "json") {
    const responseBody = res.body as Record<string, unknown> | undefined;
    if (res.status === 403 && responseBody?.error === "entitlement_denied") {
      return Response.json(
        { code: "not_entitled", message: "You do not hold an active entitlement for this kit." },
        { status: 403 }
      );
    }
    return Response.json(responseBody ?? {}, { status: res.status });
  }
  // Create should never produce a stream; defensive fallback.
  return Response.json({ error: "unexpected_stream" }, { status: 500 });
}
