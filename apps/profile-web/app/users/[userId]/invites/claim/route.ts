import { getOrgStore } from "@/lib/store";
import { claimInvites } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * POST /users/{userId}/invites/claim — claim pending email invites on first login
 * for the asserted user (body: { email }). SERVICE-context (proxied at login).
 */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const body = await parseJsonBody(request);
    const result = await claimInvites(getOrgStore(), userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
