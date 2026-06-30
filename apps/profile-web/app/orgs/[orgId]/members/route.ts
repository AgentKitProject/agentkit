import { getOrgStore } from "@/lib/store";
import { addMember, listMembers } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** GET /orgs/{orgId}/members — list members (browser-originated trusted-context). */
export async function GET(request: Request, { params }: Params) {
  try {
    requireTrustedContext(request);
    const { orgId } = await params;
    const result = await listMembers(getOrgStore(), orgId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** POST /orgs/{orgId}/members — add a member (actor = trusted-context user; owner/admin gated). */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await addMember(getOrgStore(), orgId, context.userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
