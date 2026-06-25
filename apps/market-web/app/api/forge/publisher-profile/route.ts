import { getForgePublisherProfile } from "@/lib/forge-publisher-profile";

export async function GET(request: Request) {
  return getForgePublisherProfile(request);
}
