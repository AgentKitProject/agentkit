import { getOrgStore } from "@/lib/store";
import { listUserInvites } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/** GET /users/{userId}/invites — pending invites for the asserted user (service-context). */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const result = await listUserInvites(getOrgStore(), userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
