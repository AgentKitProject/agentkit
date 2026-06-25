// /api/auto/webhooks/[id] — get / patch (enable·disable) / delete a webhook
// (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session. Ownership-checked; missing / cross-user → 404.
// The bearer sibling lives at /api/forge/auto/webhooks/[id]. The secret is NEVER
// retrievable — there is no endpoint that returns it after creation.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { deleteWebhook, getWebhook, setWebhookEnabled } from "@/server/core/auto";
import { toPublicWebhook } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
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
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
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

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const { id } = await params;
  const ok = await deleteWebhook(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}
