import { getOrgStore } from "@/lib/store";
import {
  clearOrgMonthlyLimits,
  orgMonthlyLimitsStatus,
  setOrgMonthlyLimits,
} from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** GET /orgs/{orgId}/monthly-limits — the org's four nullable caps (owner/admin). */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const result = await orgMonthlyLimitsStatus(getOrgStore(), orgId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** POST /orgs/{orgId}/monthly-limits — upsert the org's monthly caps (owner/admin). */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await setOrgMonthlyLimits(getOrgStore(), orgId, context.userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /orgs/{orgId}/monthly-limits — clear the org's monthly caps (owner/admin). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const result = await clearOrgMonthlyLimits(getOrgStore(), orgId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
