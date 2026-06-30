import { getOrgStore } from "@/lib/store";
import { orgUsageSummary } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /orgs/{orgId}/usage?period=YYYY-MM — the org's accumulated usage summary
 * for a UTC month (owner/admin): org-wide totals + per-member breakdown.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const period = new URL(request.url).searchParams.get("period");
    const result = await orgUsageSummary(getOrgStore(), orgId, context.userId, period);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
