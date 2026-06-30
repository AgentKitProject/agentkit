import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { removeMember } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string; userId: string }> };

/** DELETE /api/orgs/{orgId}/members/{userId} — remove a member (actor = signed-in user). */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId, userId } = await params;
    const result = await removeMember(getOrgStore(), orgId, userId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
