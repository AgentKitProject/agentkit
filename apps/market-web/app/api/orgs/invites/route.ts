import { browserListMyOrgInvites } from "@/lib/browser-orgs";

export async function GET() {
  return browserListMyOrgInvites();
}
