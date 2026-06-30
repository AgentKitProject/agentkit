import { getOrgStore } from "@/lib/store";
import { resolveUserOrgMonthlyUsageCheck } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userId: string }> };

/**
 * GET /users/{userId}/org-usage/check?period=YYYY-MM — service-context runtime
 * usage check (org budgets v2). Profile maps the user → their single org with
 * monthly limits set and returns its OrgUsageCheck. Returns
 * resolvedUserOrgUsageCheckSchema; fail-open (`{ found:false }`). Auto's pre-run
 * gate calls this and proceeds when the result is absent/not-found.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const url = new URL(request.url);
    const period = url.searchParams.get("period");
    const result = await resolveUserOrgMonthlyUsageCheck(getOrgStore(), userId, period);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
