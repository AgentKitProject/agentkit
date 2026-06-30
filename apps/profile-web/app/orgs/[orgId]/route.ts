import { getOrgStore } from "@/lib/store";
import { deleteOrg, getOrg } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** GET /orgs/{orgId} — fetch one org (browser-originated trusted-context). */
export async function GET(request: Request, { params }: Params) {
  try {
    requireTrustedContext(request);
    const { orgId } = await params;
    const result = await getOrg(getOrgStore(), orgId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /orgs/{orgId} — delete a team org (actor = trusted-context user). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const result = await deleteOrg(getOrgStore(), orgId, context.userId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
