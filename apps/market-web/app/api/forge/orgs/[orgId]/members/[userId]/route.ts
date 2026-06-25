import { removeOrgMember } from "@/lib/forge-orgs";

type RouteContext = { params: Promise<{ orgId: string; userId: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, userId } = await params;
  return removeOrgMember(request, orgId, userId);
}
