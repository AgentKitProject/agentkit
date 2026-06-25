import { getProfileStore } from "@/lib/store";
import { getCurrentProfile, updateCurrentProfile } from "@/lib/profile-api/handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = requireTrustedContext(request);
    const result = await getCurrentProfile(getProfileStore(), context);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = requireTrustedContext(request);
    const body = await parseJsonBody(request);
    const result = await updateCurrentProfile(getProfileStore(), context, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
