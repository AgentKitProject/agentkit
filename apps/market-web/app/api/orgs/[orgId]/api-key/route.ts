import {
  browserGetOrgApiKeyStatus,
  browserSetOrgApiKey,
  browserClearOrgApiKey
} from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

// GET — masked status of the org's shared API key (never the raw key).
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserGetOrgApiKeyStatus(request, orgId);
}

// PUT — set the org's shared API key (owner/admin gated server-side).
export async function PUT(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserSetOrgApiKey(request, orgId);
}

// DELETE — clear the org's shared API key.
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserClearOrgApiKey(request, orgId);
}
