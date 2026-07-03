// /api/auto/connections — reusable delivery connections (BROWSER / cookie).
//
//   POST → create a connection (s3 / email / webhook_out / slack_incoming).
//          A write-only `secret` is moved straight into the encrypted
//          SecretStore (→ opaque secretRef) and is NEVER echoed. gdrive /
//          dropbox → 501 (use the OAuth flow); imap → 501 (coming soon).
//   GET  → list the user's connections.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { autoEventErrorResponse } from "@/server/core/auto-events";
import {
  connectionErrorResponse,
  createConnection,
  listConnections,
} from "@/server/core/auto-connections";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }
  const body = await request.json().catch(() => ({}));
  try {
    const created = await createConnection(userId, body);
    return Response.json(created, { status: 201 });
  } catch (error) {
    const mapped = connectionErrorResponse(error) ?? autoEventErrorResponse(error);
    if (mapped) return mapped;
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
  try {
    const connections = await listConnections(userId);
    return Response.json({ connections }, { status: 200 });
  } catch (error) {
    console.error("[auto] listConnections failed", error);
    return Response.json({ connections: [] }, { status: 200 });
  }
}
