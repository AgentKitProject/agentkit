import { getOrgStore } from "@/lib/store";
import { getMembership, removeMember } from "@/lib/profile-api/org-handlers";
import { requireServiceContext, requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string; userId: string }> };

/**
 * GET /orgs/{orgId}/members/{userId} — hot membership check → {role,status}|404.
 * SERVICE-context: Market/Auto assert the TARGET userId in the path (not the
 * subject), so this uses requireServiceContext (service key only).
 */
export async function GET(request: Request, { params }: Params) {
  try {
    requireServiceContext(request);
    const { orgId, userId } = await params;
    const result = await getMembership(getOrgStore(), orgId, userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/**
 * DELETE /orgs/{orgId}/members/{userId} — remove a member. Browser-originated:
 * the actor is the trusted-context user (owner/admin gated); the path userId is
 * the member being removed.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId, userId } = await params;
    const result = await removeMember(getOrgStore(), orgId, userId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
