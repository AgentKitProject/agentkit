import { deleteOrg } from "@/lib/forge-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return deleteOrg(request, orgId);
}
