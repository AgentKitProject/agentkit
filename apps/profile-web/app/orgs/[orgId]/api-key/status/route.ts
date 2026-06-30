import { getOrgStore } from "@/lib/store";
import { orgApiKeyStatus } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * GET /orgs/{orgId}/api-key/status — masked status of ALL providers. Browser-
 * originated: actor = trusted-context user (owner/admin gated). Never the raw key.
 */
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const result = await orgApiKeyStatus(getOrgStore(), orgId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
