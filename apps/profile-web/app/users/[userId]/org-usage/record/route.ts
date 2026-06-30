import { getOrgStore } from "@/lib/store";
import { recordUserOrgMonthlyUsage } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userId: string }> };

/**
 * POST /users/{userId}/org-usage/record — service-context usage accumulation (org
 * budgets v2). Profile maps the user → their single org with monthly limits set
 * and accumulates the usage into the (org, member, period) row. Body:
 * recordUserOrgUsageRequestSchema. Returns resolvedUserOrgUsageRecordSchema;
 * fail-open (`{ recorded:false }`). Auto's post-run hook calls this best-effort.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const body = await parseJsonBody(request);
    const result = await recordUserOrgMonthlyUsage(getOrgStore(), userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
