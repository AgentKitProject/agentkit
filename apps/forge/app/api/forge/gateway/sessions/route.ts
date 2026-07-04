// POST /api/forge/gateway/sessions — create a managed gateway streaming session
// for a NON-browser client (desktop / CLI / Auto). Gateway Phase 2c-i.
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser) — NOT the AuthKit
// cookie (CLAUDE.md hard rule #4). The session is scoped to the forge user id.
//
// Body: {
//   kitId?, kitSlug?,
//   systemPrompt? | kitContext?,   // client-derived kit system context (local kit)
//   tools?: [{ name, description, input_schema }],  // local-hands tools (opt-in)
//   model?
// }
// The client supplies the kit context + tool set because a desktop/CLI kit is
// LOCAL (not in the web KitStore). Sizes are bounded server-side. Returns the
// opaque session handle (NEVER the injected system prompt or tools).
import { requireForgeUser, ForgeAuthError, parseBearerToken } from "@/lib/forge-auth";
import {
  buildForgeContext,
  classifyForgeKit,
  createForgeSession,
  createProtectedForgeSession,
  ForgeContextError,
  ForgeNotEntitledError
} from "@/server/core/forge-gateway-sessions";
import { PremiumRunOnAutoError } from "@/server/core/protected-kits";
import { MANAGED_DEFAULT_MODEL, isManagedModel } from "@/server/core/managed-models";
import { isManagedInferenceEnabled } from "@/lib/self-host";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Managed gateway inference is OFF on self-host (BYO-key only).
  if (!isManagedInferenceEnabled()) {
    return Response.json(
      { error: "managed_disabled", message: "Managed inference is not available on this instance." },
      { status: 404 }
    );
  }
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as {
    kitId?: string;
    kitSlug?: string;
    systemPrompt?: unknown;
    kitContext?: unknown;
    tools?: unknown;
    model?: string;
    // Tier-3 PROTECTED (paid / online-only Market) kit selector.
    source?: string;
    slug?: string;
    marketBaseUrl?: string;
  };

  // model is recorded for symmetry; the create call doesn't run inference.
  const _model = isManagedModel(body.model) ? body.model! : MANAGED_DEFAULT_MODEL;
  void _model;

  // KIT-TYPE CLASSIFICATION: a Market kit (source/slug) may be PROTECTED. For a
  // protected kit we IGNORE client-provided context, FORCE managed billing, and
  // ENTITLEMENT-GATE the session (403 not_entitled when the user lacks one). The
  // prompt is fetched server-side on every turn — never trusted from the client.
  if (body.source === "market" && body.slug) {
    const bearerToken = parseBearerToken(request.headers.get("authorization"));
    if (!bearerToken) {
      return Response.json({ code: "not_entitled", message: "Sign-in required for this kit." }, { status: 403 });
    }
    const ref = {
      slug: body.slug,
      ...(body.kitId ? { kitId: body.kitId } : {}),
      ...(body.marketBaseUrl ? { marketBaseUrl: body.marketBaseUrl } : {})
    };
    const classification = await classifyForgeKit(bearerToken, ref);
    if (classification.premium) {
      // PREMIUM (per_invocation) kits are AUTO-RUN-ONLY: the seller's per-run
      // royalty is metered only on the Auto run path. An INTERACTIVE run here would
      // earn the seller nothing (monetization leak), so refuse server-side and
      // direct the user to Auto. Content-free (only slug + public Auto URL).
      const err = new PremiumRunOnAutoError(ref, classification.kitId);
      return Response.json(err.toResponseBody(), { status: 409 });
    }
    if (classification.isProtected) {
      try {
        const session = await createProtectedForgeSession({ userId, bearerToken, ref });
        return Response.json(
          {
            sessionId: session.sessionId,
            kitId: session.kitId,
            billingMode: session.billingMode,
            // Protected: client context is ignored; no client tools are honored.
            toolsDeclared: 0,
            protected: true,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt
          },
          { status: 201 }
        );
      } catch (error) {
        if (error instanceof PremiumRunOnAutoError) {
          // Defense-in-depth: createProtectedForgeSession also refuses premium.
          return Response.json(error.toResponseBody(), { status: 409 });
        }
        if (error instanceof ForgeNotEntitledError) {
          return Response.json({ code: "not_entitled", message: error.message }, { status: 403 });
        }
        throw error;
      }
    }
    // Not protected (free Market kit) → falls through to the owned/local path
    // using whatever context the client supplied.
  }

  let context;
  try {
    context = buildForgeContext({
      systemPrompt: body.systemPrompt,
      kitContext: body.kitContext,
      tools: body.tools
    });
  } catch (error) {
    if (error instanceof ForgeContextError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400 });
    }
    throw error;
  }

  const session = await createForgeSession({
    userId,
    kitId: body.kitId,
    kitSlug: body.kitSlug,
    context
  });

  // NEVER return systemPromptRef content (it carries the injected context +
  // tools); only the opaque handle + non-secret metadata.
  return Response.json(
    {
      sessionId: session.sessionId,
      kitId: session.kitId,
      billingMode: session.billingMode,
      toolsDeclared: context.tools.length,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    },
    { status: 201 }
  );
}
