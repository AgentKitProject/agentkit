// /api/auto/approvals — AgentKitAuto standing approvals (BROWSER / cookie auth).
//
// Auth: AuthKit cookie session (requireUserForApi) — NEVER the forge bearer
// (CLAUDE.md hard rule #4). The bearer sibling lives at /api/forge/auto/approvals.
//
//   POST → create a standing approval { kitRef, toolAllowlist, maxBudgetCents }
//          (scope=workspace_read_write, networkPolicy=deny_all are forced server-side).
//   GET  → list the user's approvals.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireUserForApi, UnauthorizedError } from "@/lib/auth";
import {
  AutoValidationError,
  createApproval,
  listApprovals,
  parseKitRef,
  parseNetworkPolicy
} from "@/server/core/auto";
import { resolveRunBudgetCents } from "@/server/core/run-budget";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let userId: string;
  try {
    userId = (await requireUserForApi()).id;
  } catch (error) {
    if (error instanceof UnauthorizedError) return Response.json({ error: error.message }, { status: 401 });
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as {
    kitRef?: unknown;
    toolAllowlist?: unknown;
    networkPolicy?: unknown;
  };

  try {
    const kitRef = parseKitRef(body.kitRef);
    const toolAllowlist = Array.isArray(body.toolAllowlist)
      ? body.toolAllowlist.filter((t): t is string => typeof t === "string")
      : [];
    // The approval ceiling is the resolved per-run budget (org override → user
    // default → 50¢ fallback); the form no longer asks for a budget.
    const maxBudgetCents = await resolveRunBudgetCents(userId);
    // Phase C: deny_all (default) or an allowlist of egress hosts. http_fetch in
    // the toolAllowlist is honored only with an allowlist policy (createApproval enforces).
    const networkPolicy = parseNetworkPolicy(body.networkPolicy);
    const approval = await createApproval({ userId, kitRef, toolAllowlist, maxBudgetCents, networkPolicy });
    return Response.json(approval, { status: 201 });
  } catch (error) {
    if (error instanceof AutoValidationError) {
      return Response.json({ error: autoErrorCodeSchema.enum.invalid_request, message: error.message }, { status: 400 });
    }
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
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the Auto page load; the UI renders an empty state.
  try {
    const approvals = await listApprovals(userId);
    return Response.json({ approvals }, { status: 200 });
  } catch (error) {
    console.error("[auto] listApprovals failed", error);
    return Response.json({ approvals: [] }, { status: 200 });
  }
}
