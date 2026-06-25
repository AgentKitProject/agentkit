import { browserDeleteOrg } from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserDeleteOrg(request, orgId);
}
