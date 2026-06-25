// /api/forge/auto/webhooks/[id] — get / patch (enable·disable) / delete a webhook
// (BEARER auth).
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser). Ownership-checked;
// missing / cross-user → 404. The cookie sibling lives at /api/auto/webhooks/[id].
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { deleteWebhook, getWebhook, setWebhookEnabled } from "@/server/core/auto";
import { toPublicWebhook } from "@/app/api/auto/webhooks/shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  const { id } = await params;
  const webhook = await getWebhook(userId, id);
  if (!webhook) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(toPublicWebhook(webhook), { status: 200 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: "enabled (boolean) is required." }, { status: 400 });
  }
  const updated = await setWebhookEnabled(userId, id, body.enabled);
  if (!updated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(toPublicWebhook(updated), { status: 200 });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
  const { id } = await params;
  const ok = await deleteWebhook(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}
