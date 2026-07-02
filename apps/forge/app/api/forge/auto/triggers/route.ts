// /api/forge/auto/triggers — unified event-driven triggers (BEARER auth).
//
// Auth: Keycloak/OIDC device-auth BEARER token (requireForgeUser) — NEVER the
// browser cookie (CLAUDE.md hard rule #4). Cookie sibling: auto-web /api/auto/triggers. ADDITIVE: the legacy /api/auto/schedules and
// /api/auto/webhooks surfaces are untouched.
//
//   POST → create a trigger (contracts createTriggerRequestSchema —
//          discriminated on `type`; approval gate re-checked server-side).
//   GET  → list the user's triggers.
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
import { autoEventErrorResponse, createTrigger, listTriggers } from "@/server/core/auto-events";

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
    const trigger = await createTrigger(userId, body);
    return Response.json(trigger, { status: 201 });
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
  // Degrade gracefully on a read failure rather than 500-ing the page load.
  try {
    const triggers = await listTriggers(userId);
    return Response.json({ triggers }, { status: 200 });
  } catch (error) {
    console.error("[auto] listTriggers failed", error);
    return Response.json({ triggers: [] }, { status: 200 });
  }
}
