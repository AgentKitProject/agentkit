// /api/forge/auto/event-sources/[id] — get / patch / delete a source (BEARER auth). Ownership-checked; missing / cross-user → 404. The token is NEVER
// retrievable after creation (rotate-token issues a new one).
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import {
  autoEventErrorResponse,
  deleteEventSource,
  getEventSource,
  updateEventSource,
} from "@/server/core/auto-events";

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
  const source = await getEventSource(userId, id);
  if (!source) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(source, { status: 200 });
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
  const body = await request.json().catch(() => ({}));
  try {
    const updated = await updateEventSource(userId, id, body);
    if (!updated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
    return Response.json(updated, { status: 200 });
  } catch (error) {
    const mapped = autoEventErrorResponse(error);
    if (mapped) return mapped;
    throw error;
  }
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
  const ok = await deleteEventSource(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}
