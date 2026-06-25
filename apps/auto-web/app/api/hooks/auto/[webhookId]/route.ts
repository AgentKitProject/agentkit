// /api/hooks/auto/[webhookId] — PUBLIC webhook ingest (FOURTH auth path).
//
// This is the ONLY Auto endpoint authed by a per-webhook SECRET. It is NOT a
// browser route (no AuthKit cookie), NOT a Forge route (no WorkOS bearer), and
// NOT an internal route (no AUTO_WORKER_SERVICE_KEY). A third-party service POSTs
// here with the secret it was shown once at creation. CLAUDE.md hard rule #4
// (never mix auth paths) is preserved: this route imports NONE of the other
// auth helpers — the secret is the sole authorization.
//
// The secret is presented as the `x-auto-webhook-secret` header OR a `?token=`
// query param. Verification is a CONSTANT-TIME hash compare done inside
// auto-core's consumeWebhook (verifyWebhookSecret) — this route never compares
// the secret itself and NEVER logs it.
//
// On a valid secret + enabled webhook + satisfied approval gate, consumeWebhook
// creates a run (trigger "webhook") and dispatches it via the SAME startRun path
// schedules/on-demand runs use. We return the run id.
//
// Failure mapping (deliberately terse, no probing): not_found / disabled /
// bad_secret → 401 (a caller can't distinguish a missing webhook from a wrong
// secret); approval_invalid / over_budget → 403.
import { autoErrorCodeSchema, autoWebhookSecretHeader } from "@agentkitforge/contracts";
import { fireWebhook, WebhookError } from "@/server/core/auto";

export const dynamic = "force-dynamic";

/** Extract the presented secret from the header or the `?token=` query param. */
function presentedSecret(request: Request, url: URL): string | null {
  const header = request.headers.get(autoWebhookSecretHeader);
  if (header && header.length > 0) return header;
  const token = url.searchParams.get("token");
  if (token && token.length > 0) return token;
  return null;
}

export async function POST(request: Request, { params }: { params: Promise<{ webhookId: string }> }) {
  const { webhookId } = await params;
  const url = new URL(request.url);
  const secret = presentedSecret(request, url);
  if (!secret) {
    // No secret presented → 401 (the route is secret-only; never falls back).
    return Response.json({ error: autoErrorCodeSchema.enum.unauthorized }, { status: 401 });
  }

  // Best-effort parse of the inbound payload (folded into the run input by
  // consumeWebhook). A non-JSON / empty body is tolerated (payload undefined).
  let payload: unknown;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    payload = await request.json().catch(() => undefined);
  } else {
    const text = await request.text().catch(() => "");
    payload = text.length > 0 ? text : undefined;
  }

  try {
    const run = await fireWebhook({ webhookId, providedSecret: secret, payload });
    return Response.json({ id: run.id, status: run.status, createdAt: run.createdAt }, { status: 202 });
  } catch (error) {
    if (error instanceof WebhookError) {
      // Auth-ish failures → 401 (no probing which webhooks exist / valid secret).
      if (error.reason === "not_found" || error.reason === "disabled" || error.reason === "bad_secret") {
        return Response.json({ error: autoErrorCodeSchema.enum.unauthorized }, { status: 401 });
      }
      // Approval / budget gate → 403.
      return Response.json({ error: autoErrorCodeSchema.enum.approval_denied, message: error.message }, { status: 403 });
    }
    throw error;
  }
}
