import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { clearOrgApiKey, orgApiKeyStatus, setOrgApiKey } from "@/lib/profile-api/org-handlers";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * Org shared API key — owner/admin only (enforced by the handler). The raw key is
 * NEVER returned to the browser; GET surfaces only the masked per-provider status.
 *   GET    → masked status of all providers
 *   PUT    → set one provider's key (encrypted at rest)
 *   DELETE → clear one provider's key (?providerType=...)
 */

/** GET /api/orgs/{orgId}/api-key — masked status (owner/admin). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await orgApiKeyStatus(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** PUT /api/orgs/{orgId}/api-key — set one provider's key (owner/admin). */
export async function PUT(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await setOrgApiKey(getOrgStore(), orgId, user.id, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /api/orgs/{orgId}/api-key?providerType=... — clear one provider's key (owner/admin). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const providerType = new URL(request.url).searchParams.get("providerType");
    const result = await clearOrgApiKey(getOrgStore(), orgId, user.id, providerType);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
