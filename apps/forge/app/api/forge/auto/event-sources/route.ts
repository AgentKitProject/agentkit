// /api/forge/auto/event-sources — user-created ingest endpoints (BEARER auth).
//
//   POST → create a source. The response is the ONLY place the plaintext
//          ingest bearer token ever appears (shown ONCE; only its sha256 hash
//          is stored — S2). A write-only `signingSecret` (provider HMAC) is
//          moved straight into the encrypted SecretStore, never echoed.
//   GET  → list the user's sources (tokenHash NEVER exposed).
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import {
  autoEventErrorResponse,
  createEventSource,
  listEventSources,
} from "@/server/core/auto-events";

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
  const body = await request.json().catch(() => ({}));
  try {
    const created = await createEventSource(userId, body);
    // One-time plaintext token — returned here and never again.
    return Response.json(created, { status: 201 });
  } catch (error) {
    const mapped = autoEventErrorResponse(error);
    if (mapped) return mapped;
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
  try {
    const sources = await listEventSources(userId);
    return Response.json({ sources }, { status: 200 });
  } catch (error) {
    console.error("[auto] listEventSources failed", error);
    return Response.json({ sources: [] }, { status: 200 });
  }
}
