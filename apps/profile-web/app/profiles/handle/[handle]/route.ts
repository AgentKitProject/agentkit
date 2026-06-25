import { getProfileStore } from "@/lib/store";
import { getPublicProfileByHandle } from "@/lib/profile-api/handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await params;
    const result = await getPublicProfileByHandle(getProfileStore(), decodeURIComponent(handle));
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
