import { getOrgStore } from "@/lib/store";
import { orgPrivateKitCap } from "@/lib/profile-api/org-handlers";
import { requireServiceContext } from "@/lib/profile-api/trusted-context";
import { renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /orgs/{orgId}/private-kit-cap — service-context read of the org's configured
 * max private-kit count (private-kits A2). market-core calls this at set-private
 * time to override the env default. Returns `{ maxPrivateKits: number | null }`
 * (null = unlimited / no org-configured cap).
 */
export async function GET(request: Request, { params }: Params) {
  try {
    requireServiceContext(request);
    const { orgId } = await params;
    const result = await orgPrivateKitCap(getOrgStore(), orgId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
