import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { listUserInvites } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** GET /api/orgs/invites — pending org invites for the signed-in user. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const result = await listUserInvites(getOrgStore(), user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
