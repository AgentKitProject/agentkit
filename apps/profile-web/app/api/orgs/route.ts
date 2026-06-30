import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { createOrg, listUserOrgs } from "@/lib/profile-api/org-handlers";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserRole } from "@/lib/auth/roles";
import { isSelfHost } from "@/lib/self-host";

export const dynamic = "force-dynamic";

/**
 * Browser-facing org routes — authenticate via the AuthKit cookie session and
 * call Profile's own org handlers in-process (Profile is the system of record for
 * orgs). These parallel the service-key trusted-context routes under `app/orgs`
 * (the cross-service JSON API); both call the same `org-handlers`.
 */

/** GET /api/orgs — orgs the signed-in user belongs to. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const result = await listUserOrgs(getOrgStore(), user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** POST /api/orgs — create a team org (owner = signed-in user). */
export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    // Self-host only: restrict org creation to admins/owners. Hosted is unchanged
    // (any signed-in user may create an org).
    if (isSelfHost()) {
      const role = getUserRole(user);
      if (role !== "owner" && role !== "admin") {
        return NextResponse.json(
          { message: "Only an administrator can create organizations on this instance." },
          { status: 403 },
        );
      }
    }
    const body = await parseJsonBody(request);
    const result = await createOrg(getOrgStore(), user.id, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
