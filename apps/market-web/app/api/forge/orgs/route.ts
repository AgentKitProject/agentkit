import { listMyOrgs, createOrg } from "@/lib/forge-orgs";

export async function GET(request: Request) {
  return listMyOrgs(request);
}

export async function POST(request: Request) {
  return createOrg(request);
}
