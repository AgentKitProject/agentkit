import { getOrgStore } from "@/lib/store";
import { acceptInvite } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * POST /orgs/{orgId}/invites/{userId}/accept — accept a pending invite for the
 * asserted user. SERVICE-context: Market/forge proxies assert the accepting
 * userId in the path (the invitee), so this uses requireServiceContext.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orgId: string; userId: string }> }) {
  try {
    requireServiceContext(request);
    const { orgId, userId } = await params;
    const result = await acceptInvite(getOrgStore(), orgId, userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
