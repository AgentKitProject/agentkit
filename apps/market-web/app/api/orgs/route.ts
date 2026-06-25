import { browserListMyOrgs, browserCreateOrg } from "@/lib/browser-orgs";

export async function GET() {
  return browserListMyOrgs();
}

export async function POST(request: Request) {
  return browserCreateOrg(request);
}
