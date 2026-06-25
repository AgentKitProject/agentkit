import { listOrgMembers, addOrgMember } from "@/lib/forge-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return listOrgMembers(request, orgId);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return addOrgMember(request, orgId);
}
