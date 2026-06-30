import { getOrgStore } from "@/lib/store";
import { checkOrgUsage } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /orgs/{orgId}/usage/check?userId=...&period=YYYY-MM — service-context
 * remaining check. Auto calls this at run time with an asserted (orgId, userId,
 * period). Returns orgUsageCheckSchema.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    requireServiceContext(request);
    const { orgId } = await params;
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");
    const period = url.searchParams.get("period");
    const result = await checkOrgUsage(getOrgStore(), orgId, userId, period);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
