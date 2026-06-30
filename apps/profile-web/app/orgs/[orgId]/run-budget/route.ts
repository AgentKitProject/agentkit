import { getOrgStore } from "@/lib/store";
import { clearOrgRunBudget, orgRunBudgetStatus, setOrgRunBudget } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** GET /orgs/{orgId}/run-budget — { budgetCents: number | null } (owner/admin). */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const result = await orgRunBudgetStatus(getOrgStore(), orgId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** POST /orgs/{orgId}/run-budget — upsert the org default per-run budget (owner/admin). */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await setOrgRunBudget(getOrgStore(), orgId, context.userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /orgs/{orgId}/run-budget — clear the org default (owner/admin). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const result = await clearOrgRunBudget(getOrgStore(), orgId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
