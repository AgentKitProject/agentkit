import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { orgUsageSummary } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/{orgId}/usage?period=YYYY-MM — the org's accumulated usage for a
 * UTC month (owner/admin only, enforced by the handler): org-wide totals + the
 * per-member breakdown.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const period = new URL(request.url).searchParams.get("period");
    const result = await orgUsageSummary(getOrgStore(), orgId, user.id, period);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
