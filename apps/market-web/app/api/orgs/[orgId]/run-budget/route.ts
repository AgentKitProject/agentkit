import {
  browserGetOrgRunBudget,
  browserSetOrgRunBudget,
  browserClearOrgRunBudget
} from "@/lib/browser-orgs";

type RouteContext = { params: Promise<{ orgId: string }> };

// GET — the org's default run budget ({ budgetCents: number | null }).
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserGetOrgRunBudget(request, orgId);
}

// PUT — set the org's default run budget (owner/admin gated server-side).
export async function PUT(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserSetOrgRunBudget(request, orgId);
}

// DELETE — clear the org's default run budget.
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  return browserClearOrgRunBudget(request, orgId);
}
