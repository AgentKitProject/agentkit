import { browserListOrgMembers, browserAddOrgMember } from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserListOrgMembers(request, orgId);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserAddOrgMember(request, orgId);
}
