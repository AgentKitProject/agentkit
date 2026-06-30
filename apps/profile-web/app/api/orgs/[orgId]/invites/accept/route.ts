import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { acceptInvite } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** POST /api/orgs/{orgId}/invites/accept — accept a pending invite (accepter = signed-in user). */
export async function POST(_request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await acceptInvite(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
