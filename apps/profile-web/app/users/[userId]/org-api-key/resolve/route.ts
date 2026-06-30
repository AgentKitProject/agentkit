import { getOrgStore } from "@/lib/store";
import { resolveUserOrgApiKey } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/**
 * GET /users/{userId}/org-api-key/resolve?providerType=... — service-context
 * runtime resolve (decrypted). Returns resolvedOrgApiKeySchema; fail-open
 * (`{ found:false }`) on no/ambiguous match. Auto/Forge call this at inference.
 */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    requireServiceContext(request);
    const { userId } = await params;
    const providerType = new URL(request.url).searchParams.get("providerType");
    const result = await resolveUserOrgApiKey(getOrgStore(), userId, providerType);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
