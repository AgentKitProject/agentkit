import { getOrgStore } from "@/lib/store";
import { createOrg } from "@/lib/profile-api/org-handlers";
import { requireTrustedContext } from "@/lib/profile-api/trusted-context";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";

export const dynamic = "force-dynamic";

/** POST /orgs — create a team org (browser-originated; actor = trusted-context user). */
export async function POST(request: Request) {
  try {
    const context = requireTrustedContext(request);
    const body = await parseJsonBody(request);
    const result = await createOrg(getOrgStore(), context.userId, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
