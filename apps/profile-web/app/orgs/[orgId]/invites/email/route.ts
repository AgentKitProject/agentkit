import { getOrgStore } from "@/lib/store";
import { createEmailInvite } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * POST /orgs/{orgId}/invites/email — invite an as-yet-unregistered email.
 * Browser-originated: actor = trusted-context user (owner/admin gated).
 */
export async function POST(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await createEmailInvite(getOrgStore(), orgId, context.userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
