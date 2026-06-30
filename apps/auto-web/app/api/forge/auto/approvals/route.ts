// /api/forge/auto/approvals — AgentKitAuto standing approvals (BEARER auth).
//
// Auth: WorkOS device-auth BEARER token (requireForgeUser) — NEVER the AuthKit
// cookie (CLAUDE.md hard rule #4). The cookie sibling lives at /api/auto/approvals.
// Same operations, shared core logic in server/core/auto.ts.
//
//   POST → create a standing approval { kitRef, toolAllowlist, maxBudgetCents }.
//   GET  → list the user's approvals.
import { autoErrorCodeSchema } from "@agentkitforge/contracts";
import { requireForgeUser, ForgeAuthError } from "@/lib/forge-auth";
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
    userId = (await requireForgeUser(request)).id;
  } catch (error) {
    if (error instanceof ForgeAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as {
    kitRef?: unknown;
    toolAllowlist?: unknown;
    maxBudgetCents?: unknown;
    networkPolicy?: unknown;
  };

  try {
    const kitRef = parseKitRef(body.kitRef);
    const toolAllowlist = Array.isArray(body.toolAllowlist)
      ? body.toolAllowlist.filter((t): t is string => typeof t === "string")
      : [];
    const maxBudgetCents =
      typeof body.maxBudgetCents === "number" ? body.maxBudgetCents : await resolveRunBudgetCents(userId);
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
  // Degrade gracefully on a read failure (uninitialized/unreachable store)
  // rather than 500-ing the caller; an empty list is a valid empty state.
  try {
    const approvals = await listApprovals(userId);
    return Response.json({ approvals }, { status: 200 });
  } catch (error) {
    console.error("[auto] listApprovals failed", error);
    return Response.json({ approvals: [] }, { status: 200 });
  }
}
