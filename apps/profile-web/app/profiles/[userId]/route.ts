import { getProfileStore } from "@/lib/store";
import { getPublicProfileByUserId } from "@/lib/profile-api/handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const result = await getPublicProfileByUserId(getProfileStore(), decodeURIComponent(userId));
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
