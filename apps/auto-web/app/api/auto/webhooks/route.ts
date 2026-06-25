// /api/auto/webhooks — AgentKitAuto inbound webhook triggers (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi). The bearer sibling lives at
// /api/forge/auto/webhooks (CLAUDE.md hard rule #4 — never mix the two paths).
// The PUBLIC ingest endpoint (/api/hooks/auto/[webhookId]) is a SEPARATE, FOURTH
// auth path (per-webhook secret) — never a cookie/bearer/service-key.
//
//   POST → create a webhook { kitRef, budgetCents (REQUIRED), model?, approvalId
//          (REQUIRED) }. Validates the standing approval (must belong to the user +
//          match kitRef + cover the budget). Generates a secret server-side, stores
//          ONLY its hash, and RETURNS THE PLAINTEXT SECRET + ingest URL ONCE.
//   GET  → list the user's webhooks (secretHash never exposed).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  ApprovalDeniedError,
  AutoValidationError,
  createWebhook,
  listWebhooks,
  parseDeliveryConfig,
  parseKitRef
} from "@/server/core/auto";
import { webhookListResponse, createWebhookResponse } from "./shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as {
    kitRef?: unknown;
    budgetCents?: unknown;
    model?: unknown;
    approvalId?: unknown;
    deliveryConfig?: unknown;
  };
  try {
    const kitRef = parseKitRef(body.kitRef);
    const budgetCents = typeof body.budgetCents === "number" ? body.budgetCents : NaN;
    const model = typeof body.model === "string" ? body.model : undefined;
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
    // Phase D: opt-in result delivery copied onto every run this webhook fires.
    const deliveryConfig = parseDeliveryConfig(body.deliveryConfig);

    const created = await createWebhook({
      userId,
      kitRef,
      budgetCents,
      approvalId,
      ...(model ? { model } : {}),
      ...(deliveryConfig ? { deliveryConfig } : {})
    });
    // The plaintext secret + ingest URL are returned ONCE here and never again.
    return Response.json(createWebhookResponse(created), { status: 201 });
  } catch (error) {
    if (error instanceof ApprovalDeniedError) {
      return Response.json({ error: autoErrorCodeSchema.enum.approval_denied, message: error.message }, { status: 403 });
    }
    if (error instanceof AutoValidationError) {
      return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function GET() {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the Auto page load; the UI renders an empty state.
  try {
    const webhooks = await listWebhooks(userId);
    return Response.json({ webhooks: webhookListResponse(webhooks) }, { status: 200 });
  } catch (error) {
    console.error("[auto] listWebhooks failed", error);
    return Response.json({ webhooks: [] }, { status: 200 });
  }
}
