import { getOrgStore } from "@/lib/store";
import { clearOrgApiKey, setOrgApiKey } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** POST /orgs/{orgId}/api-key — set one provider's key (encrypt at rest; owner/admin). */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await setOrgApiKey(getOrgStore(), orgId, context.userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /orgs/{orgId}/api-key?providerType=... — clear one provider's key (owner/admin). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = requireTrustedContext(request);
    const { orgId } = await params;
    const providerType = new URL(request.url).searchParams.get("providerType");
    const result = await clearOrgApiKey(getOrgStore(), orgId, context.userId, providerType);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
