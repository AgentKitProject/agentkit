import { NextResponse } from "next/server";
import { getOrgStore } from "@/lib/store";
import {
  clearOrgMonthlyLimits,
  orgMonthlyLimitsStatus,
  setOrgMonthlyLimits,
} from "@/lib/profile-api/org-handlers";
import { parseJsonBody, renderError, renderResult } from "@/lib/profile-api/response";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ orgId: string }> };

/**
 * Org monthly limits (org budgets v2) — owner/admin only (enforced by the
 * handler). ADDITIVE to the per-run budget. Four nullable caps (null = unlimited):
 * pool cents/minutes (org-wide pool) + member-cap cents/minutes (per-member).
 *   GET    → { poolCents, poolMinutes, memberCapCents, memberCapMinutes }
 *   PUT    → set the caps (body: same shape)
 *   DELETE → clear all caps
 */

/** GET /api/orgs/{orgId}/monthly-limits — current caps (owner/admin). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await orgMonthlyLimitsStatus(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** PUT /api/orgs/{orgId}/monthly-limits — set the caps (owner/admin). */
export async function PUT(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const body = await parseJsonBody(request);
    const result = await setOrgMonthlyLimits(getOrgStore(), orgId, user.id, body);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}

/** DELETE /api/orgs/{orgId}/monthly-limits — clear the caps (owner/admin). */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user?.id) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    const { orgId } = await params;
    const result = await clearOrgMonthlyLimits(getOrgStore(), orgId, user.id);
    return renderResult(result);
  } catch (error) {
    return renderError(error);
  }
}
