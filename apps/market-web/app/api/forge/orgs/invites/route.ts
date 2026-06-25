import { listMyOrgInvites } from "@/lib/forge-orgs";

export async function GET(request: Request) {
  return listMyOrgInvites(request);
}
