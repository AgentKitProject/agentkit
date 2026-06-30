import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { deleteOrg, getOrg } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/** GET /api/orgs/{orgId} — fetch one org (cookie-authed). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await getOrg(getOrgStore(), orgId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /api/orgs/{orgId} — delete a team org (actor = signed-in user; owner/admin gated). */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await deleteOrg(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
