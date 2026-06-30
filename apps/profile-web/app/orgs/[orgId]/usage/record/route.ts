import { getOrgStore } from "@/lib/store";
import { recordOrgUsage } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * POST /orgs/{orgId}/usage/record — service-context usage accumulation. Auto
 * calls this after a run to add a member's spend + active-minutes into the
 * (org, member, period) row. Body: recordOrgUsageRequestSchema.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    requireServiceContext(request);
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await recordOrgUsage(getOrgStore(), orgId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
