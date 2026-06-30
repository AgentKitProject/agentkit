import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { clearOrgRunBudget, orgRunBudgetStatus, setOrgRunBudget } from "@/lib/profile-api/org-handlers";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * Org default per-run budget — owner/admin only (enforced by the handler). When
 * set it OVERRIDES each member's own default budget for every run they start.
 *   GET    → { budgetCents: number | null }
 *   PUT    → set the org default (body: { budgetCents })
 *   DELETE → clear the org default
 */

/** GET /api/orgs/{orgId}/run-budget — current org default (owner/admin). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await orgRunBudgetStatus(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** PUT /api/orgs/{orgId}/run-budget — set the org default (owner/admin). */
export async function PUT(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await setOrgRunBudget(getOrgStore(), orgId, user.id, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /api/orgs/{orgId}/run-budget — clear the org default (owner/admin). */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await clearOrgRunBudget(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
