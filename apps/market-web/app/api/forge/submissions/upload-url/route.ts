import { createForgeUploadUrl } from "@/lib/forge-submissions";

export async function POST(request: Request) {
  return createForgeUploadUrl(request);
}
