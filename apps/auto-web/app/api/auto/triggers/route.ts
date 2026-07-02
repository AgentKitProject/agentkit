// /api/auto/triggers — unified event-driven triggers (BROWSER / cookie auth).
//
// Auth: OIDC cookie session (requireUserForApi). The bearer sibling lives at
// /api/forge/auto/triggers in the forge app (CLAUDE.md hard rule #4 — never
// mix the two paths). ADDITIVE: the legacy /api/auto/schedules and
// /api/auto/webhooks surfaces are untouched.
//
//   POST → create a trigger (contracts createTriggerRequestSchema —
//          discriminated on `type`; approval gate re-checked server-side).
//   GET  → list the user's triggers.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { autoEventErrorResponse, createTrigger, listTriggers } from "@/server/core/auto-events";

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
    const trigger = await createTrigger(userId, body);
    return Response.json(trigger, { status: 201 });
  } catch (error) {
    const mapped = autoEventErrorResponse(error);
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
  // Degrade gracefully on a read failure rather than 500-ing the page load.
  try {
    const triggers = await listTriggers(userId);
    return Response.json({ triggers }, { status: 200 });
  } catch (error) {
    console.error("[auto] listTriggers failed", error);
    return Response.json({ triggers: [] }, { status: 200 });
  }
}
