// /api/forge/auto/webhooks — AgentKitAuto inbound webhook triggers (BEARER auth).
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser) — NEVER the AuthKit
// cookie (CLAUDE.md hard rule #4).
// The PUBLIC ingest endpoint is a SEPARATE, FOURTH auth path (per-webhook secret).
//
//   POST → create a webhook; returns the plaintext secret + ingest URL ONCE.
//   GET  → list the user's webhooks (secretHash never exposed).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import {
  ApprovalDeniedError,
  AutoValidationError,
  createWebhook,
  listWebhooks,
  parseDeliveryConfig,
  parseKitRef
} from "@/server/core/auto";
import { createWebhookResponse, webhookListResponse } from "./shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the caller; an empty list is a valid empty state.
  try {
    const webhooks = await listWebhooks(userId);
    return Response.json({ webhooks: webhookListResponse(webhooks) }, { status: 200 });
  } catch (error) {
    console.error("[auto] listWebhooks failed", error);
    return Response.json({ webhooks: [] }, { status: 200 });
  }
}
