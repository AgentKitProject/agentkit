import { getOrgStore } from "@/lib/store";
import { ensurePersonalOrg } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * POST /users/{userId}/personal-org — idempotently ensure the asserted user's
 * personal org (body: { displayName }). SERVICE-context: Market/Auto call this on
 * the submit/first-login path with the target userId asserted.
 */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const body = await parseJsonBody(request);
    const result = await ensurePersonalOrg(getOrgStore(), userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
