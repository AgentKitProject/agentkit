import { acceptOrgInvite } from "@/lib/forge-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return acceptOrgInvite(request, orgId);
}
