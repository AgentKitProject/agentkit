import { browserAcceptOrgInvite } from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserAcceptOrgInvite(request, orgId);
}
