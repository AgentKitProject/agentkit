import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import { addMember, createEmailInvite, listMembers } from "@/lib/profile-api/org-handlers";
import { renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveWorkOsUserIdByEmail, WorkOsAccountError } from "@/lib/orgs/workos-account";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET /api/orgs/{orgId}/members — list members (cookie-authed). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await listMembers(getOrgStore(), orgId);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/**
 * POST /api/orgs/{orgId}/members — add a member by email (actor = signed-in user;
 * owner/admin gated by the handler). An as-yet-unregistered email is stored as a
 * pending invite (claimed on that person's first login).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const body = (await request.json()) as unknown;
    const store = getOrgStore();

    // Accept { email, role } from the UI — resolve email → userId server-side.
    if (isRecord(body) && typeof body.email === "string") {
      const email = body.email.trim().toLowerCase();
      if (!email) {
        return NextResponse.json({ message: "Email is required." }, { status: 400 });
      }
      const role = typeof body.role === "string" ? body.role : "member";

      let resolvedUserId: string | undefined;
      try {
        resolvedUserId = await resolveWorkOsUserIdByEmail(email);
      } catch (err) {
        if (err instanceof WorkOsAccountError && err.code === "ACCOUNT_CONFIG_ERROR") {
          return NextResponse.json({ message: "Server configuration is incomplete." }, { status: 503 });
        }
        return NextResponse.json({ message: "Could not look up that email." }, { status: 502 });
      }

      // Not yet a registered user → store a pending email invite.
      if (!resolvedUserId) {
        const result = await createEmailInvite(store, orgId, user.id, { email, role });
        if (result.status >= 200 && result.status < 300) {
          return NextResponse.json({ pending: true, email }, { status: 201 });
        }
        return renderResult(result);
      }

      const result = await addMember(store, orgId, user.id, { userId: resolvedUserId, role });
      return renderResult(result);
    }

    // Legacy path: { userId, role }.
    const result = await addMember(store, orgId, user.id, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
