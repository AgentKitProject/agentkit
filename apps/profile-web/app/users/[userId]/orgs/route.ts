import { getOrgStore } from "@/lib/store";
import { listUserOrgs } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * GET /users/{userId}/orgs — orgs the asserted user belongs to. SERVICE-context:
 * Market asserts the TARGET userId in the path for authz/attribution.
 */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const result = await listUserOrgs(getOrgStore(), userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
