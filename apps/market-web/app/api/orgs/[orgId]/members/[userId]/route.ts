import { browserRemoveOrgMember } from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ orgId: string; userId: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, userId } = await params;
  return browserRemoveOrgMember(request, orgId, userId);
}
