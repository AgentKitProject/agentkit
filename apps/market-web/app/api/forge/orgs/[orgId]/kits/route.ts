import { listOrgKits } from "@/lib/forge-orgs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await params;
  return listOrgKits(request, orgId);
}
