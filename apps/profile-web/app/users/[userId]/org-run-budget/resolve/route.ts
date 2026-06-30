import { getOrgStore } from "@/lib/store";
import { resolveUserOrgRunBudget } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * GET /users/{userId}/org-run-budget/resolve — service-context runtime resolve.
 * Returns resolvedOrgRunBudgetSchema; fail-open (`{ found:false }`). Auto calls
 * this at run-create time, after the user's own default and before the fallback.
 */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const result = await resolveUserOrgRunBudget(getOrgStore(), userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
