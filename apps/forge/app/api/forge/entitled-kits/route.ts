// /api/forge/entitled-kits — the user's PROTECTED entitled Market kits, for the
// "run protected kit" discovery surface in web Forge (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi) — NEVER the forge bearer
// (CLAUDE.md hard rule #4). Read-only.
//
//   GET → { kits: [{ marketKitId, slug, name }] }
//
// The listing is resolved SERVER-TO-SERVICE against the Market service with
// MARKET_SERVICE_KEY (server-only; never shipped to the browser) and the asserted
// userId. The browser only ever learns public display fields (name/slug/id) —
// NEVER the entitlement record or kit content. The entitlement CHECK + the kit
// bytes stay server-side.
//
// Gated by isMarketEnabled(): on a self-host with Market disabled the list is
// always empty (fail closed) so the run surface is absent and the rest of Forge
// (build/validate/package/export of local kits) still works. A service failure
// also degrades to an empty list rather than failing the page load.
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import { isMarketEnabled } from "@/lib/self-host";
import { listEntitledKitsViaService } from "@/server/core/protected-kits";

export const dynamic = "force-dynamic";

export async function GET() {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }

  // Fail closed when Market is disabled (self-host with no own Market): never
  // call out, return an empty list so the UI hides the run surface.
  if (!isMarketEnabled()) {
    return Response.json({ kits: [] }, { status: 200 });
  }

  try {
    const kits = await listEntitledKitsViaService(userId);
    return Response.json({ kits }, { status: 200 });
  } catch (error) {
    // A listing failure must not hard-fail the Forge page load. Degrade to an
    // empty list (the run surface hides) and log for observability instead of 500.
    console.error("[forge] listEntitledKitsViaService failed", error);
    return Response.json({ kits: [] }, { status: 200 });
  }
}
