// /api/forge/auto/connections/[id] — get / patch / delete a connection
// (BEARER auth). Ownership-checked; missing / cross-user → 404. A PATCH
// `secret` rotates the stored credential (write-only; the superseded
// SecretStore ref is deleted); plaintext is never echoed in any response.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { autoEventErrorResponse } from "@/server/core/auto-events";
import {
  connectionErrorResponse,
  deleteConnection,
  getConnection,
  updateConnection,
} from "@/server/core/auto-connections";

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
  const connection = await getConnection(userId, id);
  if (!connection) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json(connection, { status: 200 });
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
    const updated = await updateConnection(userId, id, body);
    if (!updated) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
    return Response.json(updated, { status: 200 });
  } catch (error) {
    const mapped = connectionErrorResponse(error) ?? autoEventErrorResponse(error);
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
  const ok = await deleteConnection(userId, id);
  if (!ok) return Response.json({ error: autoErrorCodeSchema.enum.not_found }, { status: 404 });
  return Response.json({ ok: true }, { status: 200 });
}
